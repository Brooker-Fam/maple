export async function upload(path, blob, options) {
  if (window.__failUpload) throw new Error("Synthetic upload failure");
  options.onUploadProgress?.({ percentage: 100 });
  return { url: `https://synthetic.private.blob.vercel-storage.com/${path}` };
}
