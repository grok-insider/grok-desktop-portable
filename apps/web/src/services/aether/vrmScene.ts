/**
 * High-fidelity VRM present via three.js + @pixiv/three-vrm (VRoid Hub class).
 *
 * WebGL draws on the GPU. Animation uses THREE.AnimationMixer with multi-bone
 * humanoid clips (and optional VRMA when present under assets/aether/animations/).
 */

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import {
  createVRMAnimationClip,
  VRMAnimationLoaderPlugin,
  VRMLookAtQuaternionProxy,
} from "@pixiv/three-vrm-animation";
import {
  buildProceduralIdleClip,
  buildProceduralSpeakingClip,
} from "./idleClip";

export type VrmSceneOptions = {
  width?: number;
  height?: number;
  maxFps?: number;
  /** Optional VRMA URL for idle (overrides procedural if load succeeds). */
  idleVrmaUrl?: string;
  speakingVrmaUrl?: string;
};

export type VrmActivity = {
  speaking: boolean;
  level: number;
};

const MAX_BUFFER_LONG_EDGE = 720;
const MAX_PIXEL_RATIO = 1.25;

export class VrmScene {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private clock = new THREE.Clock();
  private vrm: VRM | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private idleAction: THREE.AnimationAction | null = null;
  private speakAction: THREE.AnimationAction | null = null;
  private raf = 0;
  private running = false;
  private active = true;
  private speaking = false;
  private level = 0;
  private idleT = 0;
  private width: number;
  private height: number;
  private canvas: HTMLCanvasElement;
  private maxFps: number;
  private frameInterval: number;
  private lastFrameMs = 0;
  private groundX = 0;
  private groundY = 0;
  private groundZ = 0;
  private faceYaw = Math.PI;
  private idleVrmaUrl?: string;
  private speakingVrmaUrl?: string;

  constructor(canvas: HTMLCanvasElement, opts: VrmSceneOptions = {}) {
    this.canvas = canvas;
    this.idleVrmaUrl = opts.idleVrmaUrl;
    this.speakingVrmaUrl = opts.speakingVrmaUrl;
    this.maxFps = Math.max(12, Math.min(60, opts.maxFps ?? 24));
    this.frameInterval = 1000 / this.maxFps;
    this.width = opts.width ?? (canvas.clientWidth || 480);
    this.height = opts.height ?? (canvas.clientHeight || 720);
    const capped = capBuffer(this.width, this.height);
    this.width = capped.w;
    this.height = capped.h;
    canvas.width = this.width;
    canvas.height = this.height;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: false,
      premultipliedAlpha: false,
      powerPreference: "high-performance",
      stencil: false,
      depth: true,
    });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(this.width, this.height, false);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(
      28,
      this.width / Math.max(1, this.height),
      0.1,
      20,
    );
    this.camera.position.set(0, 1.28, 2.55);

    const hemi = new THREE.HemisphereLight(0xfff4ea, 0x3a4050, 0.85);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xfff5e8, 1.35);
    key.position.set(0.6, 1.8, 1.4);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xc8d6ff, 0.55);
    fill.position.set(-1.2, 0.8, 0.6);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.35);
    rim.position.set(0.2, 1.2, -1.5);
    this.scene.add(rim);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.22));
  }

  get isWebGL(): boolean {
    return this.renderer.capabilities.maxTextures > 0;
  }

  async loadVrmUrl(url: string): Promise<void> {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) {
      throw new Error("VRM missing from glTF userData");
    }

    if (this.vrm) {
      this.mixer?.stopAllAction();
      this.mixer = null;
      this.idleAction = null;
      this.speakAction = null;
      this.scene.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
      this.vrm = null;
    }

    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(vrm);
    vrm.scene.rotation.y = Math.PI;
    this.faceYaw = Math.PI;

    // Look-at proxy enables VRMA look channels when present.
    if (vrm.lookAt) {
      const proxy = new VRMLookAtQuaternionProxy(vrm.lookAt);
      proxy.name = "lookAtQuaternionProxy";
      vrm.scene.add(proxy);
    }

    vrm.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) mesh.frustumCulled = true;
    });

    this.scene.add(vrm.scene);
    this.vrm = vrm;
    this.frameModel(vrm);
    await this.setupAnimations(vrm, loader);
  }

  private async setupAnimations(
    vrm: VRM,
    loader: GLTFLoader,
  ): Promise<void> {
    this.mixer = new THREE.AnimationMixer(vrm.scene);

    let idleClip: THREE.AnimationClip | null = null;
    let speakClip: THREE.AnimationClip | null = null;

    if (this.idleVrmaUrl) {
      idleClip = await loadVrmaClip(loader, this.idleVrmaUrl, vrm);
    }
    if (this.speakingVrmaUrl) {
      speakClip = await loadVrmaClip(loader, this.speakingVrmaUrl, vrm);
    }

    if (!idleClip) {
      idleClip = buildProceduralIdleClip(vrm);
    }
    if (!speakClip) {
      speakClip = buildProceduralSpeakingClip(vrm);
    }

    this.idleAction = this.mixer.clipAction(idleClip);
    this.idleAction.setLoop(THREE.LoopRepeat, Infinity);
    this.idleAction.clampWhenFinished = false;
    this.idleAction.enabled = true;
    this.idleAction.setEffectiveWeight(1);
    this.idleAction.play();

    this.speakAction = this.mixer.clipAction(speakClip);
    this.speakAction.setLoop(THREE.LoopRepeat, Infinity);
    this.speakAction.enabled = true;
    this.speakAction.setEffectiveWeight(0);
    this.speakAction.play();
  }

  private frameModel(vrm: VRM): void {
    vrm.scene.position.set(0, 0, 0);
    vrm.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(vrm.scene);
    const center = box.getCenter(new THREE.Vector3());
    vrm.scene.position.set(-center.x, -box.min.y, -center.z);
    vrm.scene.updateMatrixWorld(true);
    this.groundX = vrm.scene.position.x;
    this.groundY = vrm.scene.position.y;
    this.groundZ = vrm.scene.position.z;

    this.camera.fov = 28;
    this.camera.near = 0.1;
    this.camera.far = 30;
    this.camera.position.set(0, 1.15, 3.4);
    this.camera.lookAt(0, 0.95, 0);
    this.camera.updateProjectionMatrix();
  }

  setActivity(act: VrmActivity): void {
    const wasSpeaking = this.speaking;
    this.speaking = act.speaking;
    this.level = Math.max(0, Math.min(1, act.level));
    this.maxFps = act.speaking ? 30 : 24;
    this.frameInterval = 1000 / this.maxFps;

    // Cross-fade idle ↔ speaking body clip.
    if (this.idleAction && this.speakAction && wasSpeaking !== act.speaking) {
      const fade = 0.35;
      if (act.speaking) {
        this.speakAction.reset().play();
        this.speakAction.crossFadeFrom(this.idleAction, fade, false);
        this.speakAction.setEffectiveWeight(1);
        this.idleAction.setEffectiveWeight(0.35); // keep subtle weight under talk
      } else {
        this.idleAction.reset().play();
        this.idleAction.crossFadeFrom(this.speakAction, fade, false);
        this.idleAction.setEffectiveWeight(1);
        this.speakAction.setEffectiveWeight(0);
      }
    } else if (this.speakAction && act.speaking) {
      // Pulse speak weight with amplitude while talking.
      const w = 0.55 + 0.45 * this.level;
      this.speakAction.setEffectiveWeight(w);
      this.idleAction?.setEffectiveWeight(Math.max(0.2, 1 - w * 0.7));
    }
  }

  setActive(active: boolean): void {
    this.active = active;
  }

  setSize(width: number, height: number): void {
    const capped = capBuffer(width, height);
    this.width = capped.w;
    this.height = capped.h;
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(this.width, this.height, false);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    this.lastFrameMs = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      if (!this.active || document.hidden) return;
      const elapsed = now - this.lastFrameMs;
      if (elapsed < this.frameInterval - 0.5) return;
      this.lastFrameMs = now - (elapsed % this.frameInterval);
      const dt = Math.min(0.05, this.clock.getDelta());
      this.tick(dt);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  dispose(): void {
    this.stop();
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.idleAction = null;
    this.speakAction = null;
    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
      this.vrm = null;
    }
    this.renderer.dispose();
  }

  private tick(dt: number): void {
    this.idleT += dt;
    const vrm = this.vrm;
    if (vrm) {
      // Root faces camera; micro yaw only (feet stay grounded).
      const microYaw = Math.sin(this.idleT * 0.35) * 0.03;
      vrm.scene.rotation.y = this.faceYaw + microYaw;
      vrm.scene.position.set(this.groundX, this.groundY, this.groundZ);

      this.mixer?.update(dt);

      // Lips / face expressions (mixer handles body).
      const em = vrm.expressionManager;
      if (em) {
        if (this.speaking) {
          const pulse = 0.45 + 0.55 * Math.abs(Math.sin(this.idleT * 8.5));
          const aa = Math.max(0.08, this.level) * pulse;
          em.setValue("aa", aa);
          em.setValue("oh", aa * 0.4);
          em.setValue("ee", aa * 0.15);
          em.setValue("happy", 0.12);
        } else {
          em.setValue("aa", 0);
          em.setValue("oh", 0);
          em.setValue("ee", 0);
          em.setValue("happy", 0.04 + 0.02 * Math.sin(this.idleT * 0.5));
          // Soft blink
          const blink =
            Math.sin(this.idleT * 0.7) > 0.92
              ? 1
              : Math.sin(this.idleT * 0.7 + 1.7) > 0.97
                ? 1
                : 0;
          em.setValue("blink", blink);
        }
      }

      vrm.update(dt);
    }
    this.renderer.render(this.scene, this.camera);
  }
}

async function loadVrmaClip(
  loader: GLTFLoader,
  url: string,
  vrm: VRM,
): Promise<THREE.AnimationClip | null> {
  try {
    const gltf = await loader.loadAsync(url);
    const anims = gltf.userData.vrmAnimations as
      | { duration: number }[]
      | undefined;
    if (!anims?.length) return null;
    return createVRMAnimationClip(anims[0] as never, vrm);
  } catch {
    return null;
  }
}

function capBuffer(width: number, height: number): { w: number; h: number } {
  let w = Math.max(1, Math.round(width));
  let h = Math.max(1, Math.round(height));
  const dpr =
    typeof window !== "undefined"
      ? Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO)
      : 1;
  w = Math.round(w * dpr);
  h = Math.round(h * dpr);
  const long = Math.max(w, h);
  if (long > MAX_BUFFER_LONG_EDGE) {
    const s = MAX_BUFFER_LONG_EDGE / long;
    w = Math.max(1, Math.round(w * s));
    h = Math.max(1, Math.round(h * s));
  }
  return { w, h };
}

export async function createVrmScene(
  canvas: HTMLCanvasElement,
  vrmUrl: string,
  opts?: VrmSceneOptions,
): Promise<VrmScene> {
  const scene = new VrmScene(canvas, opts);
  await scene.loadVrmUrl(vrmUrl);
  return scene;
}
