'use client';

import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { getWritingSkillCommand, getWritingSkillId, MAX_SELECTED_WRITING_SKILLS, MAX_WRITING_SKILL_CHARACTERS, prepareWritingSkills, type WritingSkill } from '../lib/writing-skills';
import './writing-skills.css';

type Props = {
  skills: WritingSkill[];
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
};

// 技能标签属于当前书的本次写作选择，斜杠命令只负责选择，不会进入小说意图。
export function WritingSkillInput({ skills, selectedIds, onSelectionChange, value, onChange, disabled = false, placeholder = '描述接下来发生的故事，输入 / 选择写作技能…', onKeyDown }: Props) {
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const listId = useId();
  const [caret, setCaret] = useState(value.length);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [selectionError, setSelectionError] = useState('');
  const command = getWritingSkillCommand(value, caret);
  const available = skills.map((skill, index) => ({ skill, id: getWritingSkillId(skill, index) })).filter(({ skill }) => skill.enabled);
  const selected = available.filter(({ id }) => selectedIds.includes(id));
  const options = available.filter(({ skill, id }) => !selectedIds.includes(id) && (!command?.query || (skill.title + ' ' + skill.description).toLowerCase().includes(command.query.toLowerCase())));
  const visible = !disabled && menuOpen && command !== null;
  const highlighted = Math.min(activeIndex, Math.max(0, options.length - 1));
  let chars = 0;
  let referencesLoaded = 0;
  let budgetError = '';
  try { ({ chars, referencesLoaded } = prepareWritingSkills(skills, selectedIds, value)); } catch (error) { budgetError = error instanceof Error ? error.message : '技能内容无效'; }

  function select(id: string) {
    if (disabled || !command) return;
    if (selected.length >= MAX_SELECTED_WRITING_SKILLS) { setSelectionError(`每次最多选择 ${MAX_SELECTED_WRITING_SKILLS} 个写作技能`); return; }
    onSelectionChange([...new Set([...selected.map((item) => item.id), id])]);
    const next = value.slice(0, command.start) + value.slice(command.end);
    onChange(next);
    setCaret(command.start); setMenuOpen(false); setSelectionError('');
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(command.start, command.start); });
  }

  function openMenu() {
    const element = input.current;
    if (!element || disabled) return;
    const start = element.selectionStart;
    const end = element.selectionEnd;
    const prefix = start > 0 && !/\s/.test(value[start - 1]) ? ' /' : '/';
    const next = value.slice(0, start) + prefix + value.slice(end);
    const position = start + prefix.length;
    onChange(next); setCaret(position); setMenuOpen(true); setActiveIndex(0);
    requestAnimationFrame(() => { element.focus(); element.setSelectionRange(position, position); });
  }

  return <div className="writing-skill-compose">
    <textarea ref={input} aria-label="剧情意图" placeholder={placeholder} value={value} disabled={disabled} aria-controls={visible ? listId : undefined} aria-autocomplete="list" aria-activedescendant={visible && options.length ? `${listId}-${highlighted}` : undefined}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onChange={(event) => {
        const next = event.target.value; const position = event.target.selectionStart;
        onChange(next); setCaret(position); setActiveIndex(0); setSelectionError('');
        setMenuOpen(getWritingSkillCommand(next, position) !== null);
      }}
      onSelect={(event) => { setCaret(event.currentTarget.selectionStart); }}
      onBlur={() => { setMenuOpen(false); }}
      onKeyDown={(event) => {
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (visible) {
          if (event.key === 'Escape') { event.preventDefault(); setMenuOpen(false); return; }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((old) => options.length ? (Math.min(old, options.length - 1) + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length : 0); return; }
          if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && options.length) { event.preventDefault(); select(options[highlighted].id); return; }
        }
        onKeyDown?.(event);
      }} />
    {visible && <div className="writing-skill-menu"><div className="writing-skill-menu-title">选择本次写作技能 <span>↑ ↓ 选择 · Enter 添加 · Esc 关闭</span></div><div id={listId} role="listbox" aria-label="可用写作技能">{options.length ? options.map(({ skill, id }, index) => <div key={id} id={`${listId}-${index}`} role="option" aria-selected={index === highlighted} className={index === highlighted ? 'active' : ''} onMouseDown={(event) => { event.preventDefault(); select(id); }} onMouseEnter={() => setActiveIndex(index)}><b>{skill.title}</b><small>{skill.description}</small></div>) : <p>{available.length ? '没有匹配的可用技能，已选技能不会重复添加。' : '本书还没有启用的技能，请到“写作技能”创建或导入。'}</p>}</div></div>}
    <div className="writing-skill-toolbar"><button type="button" className="writing-skill-picker" disabled={disabled} aria-haspopup="listbox" aria-expanded={visible} aria-controls={visible ? listId : undefined} onClick={openMenu}>／ 选择技能</button><small>仅发送已选技能 · 最多 {MAX_SELECTED_WRITING_SKILLS} 个</small></div>
    {selected.length > 0 && <div className="writing-skill-chips" aria-label="本次已选写作技能">{selected.map(({ skill, id }) => <span key={id}><b>{skill.title}</b><button type="button" disabled={disabled} aria-label={`移除写作技能 ${skill.title}`} onClick={() => { onSelectionChange(selectedIds.filter((item) => item !== id)); setSelectionError(''); }}>×</button></span>)}</div>}
    {selected.length > 0 && !budgetError && <small className="writing-skill-budget">技能正文与参考资料约 {chars.toLocaleString()} / {MAX_WRITING_SKILL_CHARACTERS.toLocaleString()} 字符{referencesLoaded > 0 ? ` · 按需加载 ${referencesLoaded} 份参考资料` : ''}，字符数不等于计费 Token。</small>}
    {(selectionError || budgetError) && <p className="writing-skill-error" role="alert">{selectionError || budgetError}</p>}
  </div>;
}
