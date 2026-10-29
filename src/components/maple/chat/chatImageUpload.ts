import { CHAT_IMAGE_MAX_BYTES, CHAT_IMAGE_MAX_DIMENSION } from "@/lib/maple/chat/images";

export async function prepareChatImage(file: File): Promise<Blob> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error("Choose a JPEG, PNG or WebP photo.");
  if (file.size > 30 * 1024 * 1024) throw new Error("That photo is too large. Choose one under 30 MB.");
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    image.src = url;
    await image.decode().catch(() => { throw new Error("Couldn't open that photo. Choose another photo."); });
    let dimension = CHAT_IMAGE_MAX_DIMENSION;
    for (let attempt = 0; attempt < 5; attempt++) {
      const scale = Math.min(1, dimension / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      try {
        const context = canvas.getContext("2d");
        if (!context) throw new Error("This browser couldn't prepare the photo.");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const encoded = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
        if (encoded && encoded.size <= CHAT_IMAGE_MAX_BYTES) return encoded;
      } finally {
        canvas.width = canvas.height = 0;
      }
      dimension = Math.floor(dimension * 0.75);
    }
    throw new Error("Couldn't make that photo small enough. Choose a smaller photo.");
  } finally {
    URL.revokeObjectURL(url);
  }
}
