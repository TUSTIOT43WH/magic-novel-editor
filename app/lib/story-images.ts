export type StoryImage = { id: string; name: string; dataUrl: string };
export const MAX_STORY_IMAGES = 4;
export const MAX_STORY_IMAGE_BYTES = 5 * 1024 * 1024;
export const STORY_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export function validateStoryImages(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_STORY_IMAGES) {
    throw new Error('每次最多上传 4 张图片');
  }
  return value.map((url) => {
    if (typeof url !== 'string' || url.length > Math.ceil(MAX_STORY_IMAGE_BYTES / 3) * 4 + 64) {
      throw new Error('单张图片不能超过 5 MB');
    }
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
    if (!match || match[2].length % 4 !== 0) throw new Error('图片格式无效，请使用 PNG、JPEG 或 WebP');
    const padding = match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0;
    if (match[2].length / 4 * 3 - padding > MAX_STORY_IMAGE_BYTES) throw new Error('单张图片不能超过 5 MB');
    const header = atob(match[2].slice(0, 32));
    const valid = match[1] === 'image/png' ? header.startsWith('\x89PNG\r\n\x1a\n')
      : match[1] === 'image/jpeg' ? header.startsWith('\xff\xd8\xff')
      : header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP';
    if (!valid) throw new Error('图片内容与格式不匹配，请重新选择图片');
    return url;
  });
}

export async function readStoryImage(file: File): Promise<StoryImage> {
  if (!STORY_IMAGE_TYPES.includes(file.type)) throw new Error('仅支持 PNG、JPEG 和 WebP 图片');
  if (!file.size || file.size > MAX_STORY_IMAGE_BYTES) throw new Error('请选择非空且不超过 5 MB 的图片');
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('图片读取失败，请重新选择'));
    reader.onabort = () => reject(new Error('图片读取已取消'));
    reader.readAsDataURL(file);
  });
  validateStoryImages([dataUrl]);
  const preview = new Image();
  preview.src = dataUrl;
  try { await preview.decode(); } catch { throw new Error('图片损坏或无法解码，请重新选择'); }
  return { id: crypto.randomUUID(), name: file.name, dataUrl };
}
