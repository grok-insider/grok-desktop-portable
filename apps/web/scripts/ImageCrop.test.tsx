import {act, fireEvent, render, screen} from "@testing-library/react";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {ImageCrop} from "../src/components/ImageCrop";
import {ImageAttachments} from "../src/components/ImageAttachments";
import type {ImageComposer} from "../src/services/useImageComposer";
import type {PreparedImage} from "../src/services/imageUploads";

const image: PreparedImage = {id: "chosen", name: "synthetic.png", width: 64, height: 64, blob: new Blob(["pixels"]), preview: "blob:original"};
const composer = (): ImageComposer => ({images: [image], busy: false, capable: true, storage: "off", add: vi.fn(), remove: vi.fn(), submit: vi.fn(), crop: vi.fn().mockResolvedValue(true)});
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {configurable: true, value() {this.open = true;}});
  Object.defineProperty(HTMLDialogElement.prototype, "close", {configurable: true, value() {this.open = false;}});
});
afterEach(() => vi.restoreAllMocks());

it("supports precise keyboard and range cropping without changing the attachment before Apply", async () => {
  const value = composer();
  const done = vi.fn();
  render(<ImageCrop image={image} composer={value} onDone={done} />);
  fireEvent.change(screen.getByRole("slider", {name: "Width"}), {target: {value: "32"}});
  fireEvent.change(screen.getByRole("slider", {name: "Height"}), {target: {value: "32"}});
  fireEvent.keyDown(screen.getByRole("button", {name: "Move crop"}), {key: "ArrowRight", shiftKey: true});
  fireEvent.keyDown(screen.getByRole("button", {name: "Move crop"}), {key: "ArrowDown"});
  fireEvent.keyDown(screen.getByRole("button", {name: "Resize crop"}), {key: "ArrowLeft"});
  expect(value.crop).not.toHaveBeenCalled();
  expect(screen.getByRole("slider", {name: "Left"})).toHaveValue("10");
  expect(screen.getByRole("slider", {name: "Top"})).toHaveValue("1");
  await act(async () => fireEvent.click(screen.getByRole("button", {name: "Apply crop"})));
  expect(value.crop).toHaveBeenCalledWith(image.id, {x: 10, y: 1, width: 31, height: 32}, expect.any(AbortSignal));
  expect(done).toHaveBeenCalledOnce();
  expect(value.submit).not.toHaveBeenCalled();
});

it("keeps every keyboard crop within its bounds and at least 512 pixels", () => {
  render(<ImageCrop image={image} composer={composer()} onDone={() => {}} />);
  const resize = screen.getByRole("button", {name: "Resize crop"});
  for (let index = 0; index < 100; index++) fireEvent.keyDown(resize, {key: "ArrowLeft", shiftKey: true});
  for (let index = 0; index < 100; index++) fireEvent.keyDown(resize, {key: "ArrowUp", shiftKey: true});
  expect(screen.getByRole("slider", {name: "Width"})).toHaveValue("8");
  expect(screen.getByRole("slider", {name: "Height"})).toHaveValue("64");
  fireEvent.click(screen.getByRole("button", {name: "Reset crop"}));
  expect(screen.getByRole("slider", {name: "Width"})).toHaveValue("64");
});

it("Cancel and closing the editor abort pending preparation and never submit", async () => {
  const value = composer();
  let finish!: (value: boolean) => void;
  vi.mocked(value.crop).mockReturnValue(new Promise(resolve => {finish = resolve;}));
  const done = vi.fn();
  const rendered = render(<ImageCrop image={image} composer={value} onDone={done} />);
  fireEvent.click(screen.getByRole("button", {name: "Apply crop"}));
  const signal = vi.mocked(value.crop).mock.calls[0][2]!;
  fireEvent.click(screen.getByRole("button", {name: "Cancel crop"}));
  expect(signal.aborted).toBe(true);
  rendered.unmount();
  await act(async () => finish(false));
  expect(done).toHaveBeenCalledOnce();
  expect(value.submit).not.toHaveBeenCalled();
});

it("closes the image editor when a different conversation reuses an image id", () => {
  const value = composer();
  const rendered = render(<ImageAttachments composer={value} />);
  fireEvent.click(screen.getByRole("button", {name: "Preview synthetic.png"}));
  fireEvent.click(screen.getByRole("button", {name: "Crop image"}));
  expect(screen.getByRole("dialog", {name: "Crop image"})).toBeVisible();
  rendered.rerender(<ImageAttachments composer={{...value, images: [{...image, preview: "blob:another-conversation"}]}} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(value.crop).not.toHaveBeenCalled();
});
