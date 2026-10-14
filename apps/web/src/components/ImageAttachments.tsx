import { useState } from "react";
import { X } from "lucide-react";
import { Button, IconButton } from "./ui";
import { ComposerDialog } from "./ComposerDialog";
import { ImageCrop } from "./ImageCrop";
import type { ImageComposer } from "../services/useImageComposer";
import type { PreparedImage } from "../services/imageUploads";

export function ImageAttachments({composer}: {composer: ImageComposer}) {
  const [shown, setShown] = useState<PreparedImage>();
  const [cropping, setCropping] = useState(false);
  const image = composer.images.find(value => value === shown);
  return <div className="px-3 pt-2">
    {composer.images.length > 0 && <ul aria-label="Selected images" className="flex gap-3 overflow-x-auto pb-2">{composer.images.map(image => <li key={image.id} className="flex shrink-0 items-center gap-1 rounded-md border border-border p-1"><Button variant="ghost" className="h-16 max-w-40" onClick={() => {setShown(image); setCropping(false);}} aria-label={`Preview ${image.name}`}><img src={image.preview} alt="" className="h-14 w-14 object-contain" /><span className="max-w-20 truncate">{image.name}</span></Button><IconButton className="min-h-11 min-w-11" aria-label={`Remove ${image.name}`} disabled={composer.busy} onClick={() => composer.remove(image.id)}><X size={16} /></IconButton></li>)}</ul>}
    {composer.images.length > 0 && <p className="text-body-sm text-muted-foreground">{composer.storage === "off" ? "Image saving is off. Reloading discards this selection." : composer.storage === "saving" ? "Saving images… Keep this tab open." : composer.storage === "failed" ? "Images were not saved. Keep this tab open and free browser storage before reloading." : "Images saved on this device for seven days. Nothing is sent automatically."}</p>}
    {composer.progress && <p role="status" className="text-body-sm">{composer.progress}</p>}
    {composer.error && <p role="alert" className="text-body-sm text-warning">{composer.error}</p>}
    <ComposerDialog open={Boolean(image)} title={cropping ? "Crop image" : "Image preview"} description={image ? `${image.name} · ${image.width} × ${image.height} pixels` : undefined} onClose={() => {setShown(undefined); setCropping(false);}}>{image && (cropping ? <ImageCrop key={image.preview} image={image} composer={composer} onDone={() => setCropping(false)} /> : <div className="space-y-4"><img src={image.preview} alt={image.name} className="max-h-[65dvh] max-w-full object-contain" /><Button className="min-h-11" disabled={composer.busy || !composer.capable} onClick={() => setCropping(true)}>Crop image</Button></div>)}</ComposerDialog>
  </div>;
}
