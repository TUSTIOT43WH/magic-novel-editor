export type WritingSkillReference = { path: string; content: string };
export type WritingSkill = {
  id?: string;
  title: string;
  description: string;
  enabled: boolean;
  instructions?: string;
  references?: WritingSkillReference[];
};
export type WritingSkillPayload = {
  id: string;
  title: string;
  instructions: string;
  references: WritingSkillReference[];
};

export const MAX_SELECTED_WRITING_SKILLS = 3;
export const MAX_WRITING_SKILL_CHARACTERS = 24000;
export const MAX_WRITING_SKILL_INSTRUCTIONS = 12000;
const MAX_ZIP_BYTES = 2 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 40;
const MAX_ZIP_TEXT_BYTES = 128 * 1024;
const MAX_ZIP_TOTAL_BYTES = 512 * 1024;

// 旧技能没有 ID 时仍可稳定选择；已有 ID 的技能在改名后保持选择不变。
export function getWritingSkillId(skill: WritingSkill, index: number) {
  if (skill.id?.trim()) return skill.id;
  let hash = 2166136261;
  for (const character of skill.title + '\n' + skill.description) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `legacy-skill-${index}-${(hash >>> 0).toString(16)}`;
}

function referenceTerms(query: string) {
  const terms = new Set<string>();
  for (const word of query.toLowerCase().match(/[a-z0-9_-]{2,}|[\u4e00-\u9fff]{2,}/g) || []) {
    if (/^[\u4e00-\u9fff]+$/.test(word)) {
      for (let i = 0; i < word.length - 1; i += 1) terms.add(word.slice(i, i + 2));
    } else terms.add(word);
  }
  for (const common of ['这个', '那个', '一个', '他们', '她们', '我们', '继续', '一下', '然后', '现在', '这里', '可以']) terms.delete(common);
  return [...terms];
}

// 长参考文件围绕实际命中的位置取片段，避免命中在文件尾部却只发送开头。
function excerptReference(content: string, terms: string[], limit: number) {
  if (content.length <= limit) return content;
  const prefix = '【参考资料节选】\n';
  const suffix = '\n【节选结束】';
  const length = limit - prefix.length - suffix.length;
  const lower = content.toLowerCase();
  const hits = [...new Set(terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0))];
  let start = 0;
  let bestScore = -1;
  for (const hit of hits.slice(0, 64)) {
    const candidateStart = Math.max(0, Math.min(content.length - length, hit - Math.floor(length / 4)));
    const candidate = lower.slice(candidateStart, candidateStart + length);
    const score = terms.reduce((total, term) => total + (candidate.includes(term) ? 1 : 0), 0);
    if (score > bestScore) { start = candidateStart; bestScore = score; }
  }
  return prefix + content.slice(start, start + length) + suffix;
}

// 核心规则完整发送，参考资料只在与本次意图有关时节选，避免整个技能包占用上下文。
export function prepareWritingSkills(skills: WritingSkill[], selectedIds: string[], query: string) {
  const selected = new Set(selectedIds);
  const available = skills.map((skill, index) => ({ skill, id: getWritingSkillId(skill, index) })).filter(({ skill, id }) => skill.enabled && selected.has(id));
  if (available.length > MAX_SELECTED_WRITING_SKILLS) throw new Error(`每次最多选择 ${MAX_SELECTED_WRITING_SKILLS} 个写作技能`);
  const writingSkills: WritingSkillPayload[] = available.map(({ skill, id }) => {
    const title = skill.title.trim();
    const instructions = (skill.instructions?.trim() || skill.description.trim());
    if (!title || title.length > 100 || id.length > 200) throw new Error('技能名称应为 1～100 字符，请编辑后重试');
    if (!instructions) throw new Error(`“${title}”没有写作规则，请先补充`);
    if (instructions.length > MAX_WRITING_SKILL_INSTRUCTIONS) throw new Error(`“${title}”的核心规则超过 ${MAX_WRITING_SKILL_INSTRUCTIONS} 字符，请精简后再使用`);
    return { id, title, instructions, references: [] };
  });
  let chars = writingSkills.reduce((sum, skill) => sum + skill.id.length + skill.title.length + skill.instructions.length, 0);
  if (chars > MAX_WRITING_SKILL_CHARACTERS) throw new Error(`所选技能的核心规则超过 ${MAX_WRITING_SKILL_CHARACTERS} 字符，请减少技能或精简规则`);
  const terms = referenceTerms(query);
  const candidates = available.flatMap(({ skill }, skillIndex) => (skill.references || []).map((reference, index) => {
    const title = reference.path.toLowerCase();
    const content = reference.content.toLowerCase();
    const score = terms.reduce((sum, term) => sum + (title.includes(term) ? 4 : 0) + (content.includes(term) ? 1 : 0), 0);
    return { reference, skillIndex, index, score };
  })).filter(({ score, reference }) => score > 0 && reference.path.length <= 200 && reference.content.trim());
  candidates.sort((left, right) => right.score - left.score || left.skillIndex - right.skillIndex || left.index - right.index);
  let referencesLoaded = 0;
  for (const { reference, skillIndex } of candidates) {
    if (writingSkills[skillIndex].references.length >= 3) continue;
    const remaining = MAX_WRITING_SKILL_CHARACTERS - chars - reference.path.length;
    if (remaining < 160) continue;
    const limit = Math.min(3000, remaining);
    const content = excerptReference(reference.content, terms, limit);
    writingSkills[skillIndex].references.push({ path: reference.path, content });
    chars += reference.path.length + content.length;
    referencesLoaded += 1;
  }
  return { writingSkills, chars, referencesLoaded };
}

// 斜杠只在输入开头或空白后触发，避免把 URL 中的斜杠识别成命令。
export function getWritingSkillCommand(value: string, caret = value.length) {
  const before = value.slice(0, caret);
  const match = before.match(/(?:^|\s)\/([^\n/]{0,60})$/u);
  if (!match) return null;
  return { start: before.lastIndexOf('/'), end: caret, query: match[1].trim() };
}

function assertSafePath(path: string) {
  if (!path || path.length > 200 || /[\u0000-\u001f\\:]/.test(path) || path.startsWith('/') || path.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error('技能包包含不安全或过长的文件路径');
  }
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// 流式限制解压后的实际大小，不能只相信 ZIP 目录声明的体积。
async function inflateZipEntry(bytes: Uint8Array, method: number, expectedSize: number) {
  if (method === 0) return bytes;
  if (method !== 8) throw new Error('技能 ZIP 仅支持普通压缩或不压缩格式');
  if (typeof DecompressionStream === 'undefined') throw new Error('当前浏览器不支持 ZIP 解压，请升级浏览器或手动创建技能');
  let decompressor: DecompressionStream;
  try { decompressor = new DecompressionStream('deflate-raw'); } catch { throw new Error('当前浏览器不支持 ZIP 解压，请升级浏览器或手动创建技能'); }
  const reader = new Blob([new Uint8Array(bytes).buffer]).stream().pipeThrough(decompressor).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_ZIP_TEXT_BYTES || total > expectedSize) throw new Error('技能包解压体积超过限制');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error instanceof Error && error.message.startsWith('技能') ? error : new Error('技能 ZIP 压缩数据损坏');
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

type ZipEntry = { path: string; compressedSize: number; size: number; method: number; offset: number; crc: number; flags: number };

// 只读取包内的 UTF-8 文本，不执行脚本、不创建本地文件，也不发起网络请求。
export async function importWritingSkillZip(file: Blob): Promise<WritingSkill> {
  if (!file.size || file.size > MAX_ZIP_BYTES) throw new Error('技能 ZIP 应小于 2 MB');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer);
  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index -= 1) {
    if (view.getUint32(index, true) === 0x06054b50 && index + 22 + view.getUint16(index + 20, true) === bytes.length) { end = index; break; }
  }
  if (end < 0) throw new Error('无法识别技能 ZIP，请选择完整的 .zip 文件');
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || count !== view.getUint16(end + 8, true)) throw new Error('不支持分卷技能 ZIP');
  if (!count || count > MAX_ZIP_ENTRIES || directoryOffset + directorySize > end) throw new Error('技能包最多包含 40 个文件或目录，且必须是完整的普通 ZIP');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const decode = (input: Uint8Array) => { try { return decoder.decode(input); } catch { throw new Error('技能文件名与内容需要使用 UTF-8 编码'); } };
  const entries: ZipEntry[] = [];
  const paths = new Set<string>();
  let position = directoryOffset;
  let totalSize = 0;
  for (let index = 0; index < count; index += 1) {
    if (position + 46 > end || view.getUint32(position, true) !== 0x02014b50) throw new Error('技能 ZIP 文件目录损坏');
    const flags = view.getUint16(position + 8, true);
    const method = view.getUint16(position + 10, true);
    const compressedSize = view.getUint32(position + 20, true);
    const size = view.getUint32(position + 24, true);
    const nameSize = view.getUint16(position + 28, true);
    const extraSize = view.getUint16(position + 30, true);
    const commentSize = view.getUint16(position + 32, true);
    const attributes = view.getUint32(position + 38, true);
    const offset = view.getUint32(position + 42, true);
    const next = position + 46 + nameSize + extraSize + commentSize;
    if (next > directoryOffset + directorySize || next > end) throw new Error('技能 ZIP 文件目录不完整');
    const path = decode(bytes.subarray(position + 46, position + 46 + nameSize));
    assertSafePath(path);
    if ((flags & 1) || (attributes >>> 16 & 0xf000) === 0xa000 || view.getUint16(position + 34, true)) throw new Error('技能包不能包含加密文件、符号链接或分卷文件');
    if (paths.has(path.toLowerCase())) throw new Error('技能包包含重复文件路径');
    paths.add(path.toLowerCase());
    totalSize += size;
    if (size > MAX_ZIP_TEXT_BYTES || totalSize > MAX_ZIP_TOTAL_BYTES || size > Math.max(1024, compressedSize * 200)) throw new Error('技能包解压体积或压缩比例超过限制');
    if (!path.endsWith('/')) entries.push({ path, compressedSize, size, method, offset, flags, crc: view.getUint32(position + 16, true) });
    position = next;
  }
  if (position !== directoryOffset + directorySize) throw new Error('技能 ZIP 文件目录不完整');
  const manifests = entries.filter(({ path }) => /(^|\/)SKILL\.md$/i.test(path));
  if (manifests.length !== 1) throw new Error('技能包需要包含且只能包含一个 SKILL.md');
  const manifest = manifests[0];
  const prefix = manifest.path.slice(0, -'SKILL.md'.length);
  if (prefix.split('/').filter(Boolean).length > 1) throw new Error('请把 SKILL.md 放在 ZIP 根目录或第一层技能目录');
  const accepted = entries.filter(({ path }) => path === manifest.path || (path.startsWith(prefix + 'references/') && /\.(?:md|txt|json)$/i.test(path)));
  if (accepted.length > 21) throw new Error('每个技能最多导入 20 份参考资料');
  const texts = new Map<string, string>();
  for (const entry of accepted) {
    if (entry.offset + 30 > directoryOffset || view.getUint32(entry.offset, true) !== 0x04034b50) throw new Error('技能 ZIP 文件头损坏');
    const nameSize = view.getUint16(entry.offset + 26, true);
    const extraSize = view.getUint16(entry.offset + 28, true);
    const dataOffset = entry.offset + 30 + nameSize + extraSize;
    if (dataOffset + entry.compressedSize > directoryOffset || decode(bytes.subarray(entry.offset + 30, entry.offset + 30 + nameSize)) !== entry.path || view.getUint16(entry.offset + 8, true) !== entry.method || view.getUint16(entry.offset + 6, true) !== entry.flags) throw new Error('技能 ZIP 文件头与目录不一致');
    const content = await inflateZipEntry(bytes.subarray(dataOffset, dataOffset + entry.compressedSize), entry.method, entry.size);
    if (content.length !== entry.size || crc32(content) !== entry.crc) throw new Error('技能 ZIP 文件校验失败，请重新打包');
    const text = decode(content).replace(/^\uFEFF/, '');
    if (text.includes('\u0000')) throw new Error('技能包只能导入普通文本');
    texts.set(entry.path, text);
  }
  let instructions = texts.get(manifest.path)!.trim();
  let title = '';
  let description = '';
  if (/^---\r?\n/.test(instructions)) {
    const frontmatter = instructions.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!frontmatter) throw new Error('SKILL.md 的前置元数据缺少结束分隔线');
    const field = (name: string) => {
      const found = frontmatter[1].match(new RegExp('^' + name + ':[ \\t]*([^\\r\\n]*)', 'mi'))?.[1]?.trim() || '';
      if (/^[|>]/.test(found)) throw new Error('技能 name 和 description 请使用单行文本');
      return found.replace(/^(["'])([\s\S]*)\1$/, '$2');
    };
    title = field('name');
    description = field('description');
    instructions = instructions.slice(frontmatter[0].length).trim();
  }
  title ||= instructions.match(/^#\s+(.+)$/m)?.[1]?.trim() || '导入的写作技能';
  if (title.length > 100 || !instructions || instructions.length > MAX_WRITING_SKILL_INSTRUCTIONS) throw new Error('技能名称最多 100 字符，核心规则应为 1～12000 字符');
  description ||= instructions.replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').slice(0, 160);
  if (description.length > 1000) throw new Error('技能简介最多 1000 字符');
  return {
    id: crypto.randomUUID(), title, description, enabled: true, instructions,
    references: accepted.filter(({ path }) => path !== manifest.path).map(({ path }) => ({ path: path.slice(prefix.length), content: texts.get(path)! })),
  };
}
