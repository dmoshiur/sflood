import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Card, Empty, Field, Loading, Notice, Tabs } from '../components/ui';
import { parseSitePage, type SiteBlock } from '../../shared/site-blocks';
import { BlockRenderer } from '../components/visuals';

/**
 * Schema-driven site builder.
 *
 * Editors drag whitelisted blocks into a page, edit their fields, preview the
 * result, save a draft, publish an immutable version and roll back. Content is
 * validated against the block schema on the server and rendered by a fixed
 * component map, so no user-supplied script or style can ever execute.
 */

type Row = Record<string, unknown>;

export default function SiteBuilderPage() {
  const [pages, setPages] = useState<Row[]>([]);
  const [pageId, setPageId] = useState('');
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const [blocks, setBlocks] = useState<SiteBlock[]>([]);
  const [library, setLibrary] = useState<Array<{ type: string; label: string; description: string; template: SiteBlock }>>([]);
  const [versions, setVersions] = useState<Row[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [tab, setTab] = useState<'edit' | 'preview' | 'versions'>('edit');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newSlug, setNewSlug] = useState('');
  const [newTitle, setNewTitle] = useState('');

  const loadPages = useCallback(async () => {
    try {
      const result = await api.pages();
      setPages(result.pages as unknown as Row[]);
      if (!pageId && result.pages.length) setPageId(String(result.pages[0]!.id));
      setError(null);
    } catch (err) { setError((err as Error).message); }
  }, [pageId]);

  useEffect(() => { void loadPages(); void api.blockLibrary().then((result) => setLibrary(result.library)); }, [loadPages]);

  const loadPage = useCallback(async (id: string) => {
    if (!id) return;
    try {
      const [page, list] = await Promise.all([api.page(id), api.pages()]);
      setSlug(page.page.slug);
      setTitle(page.page.title);
      setBlocks(page.page.blocks || []);
      const current = (list.pages as unknown as Row[]).find((row) => String(row.id) === id);
      setVersions((current?.versions || []) as Row[]);
      setSelected(page.page.blocks?.[0] ? String(page.page.blocks[0].id) : null);
    } catch (err) { setError((err as Error).message); }
  }, []);

  useEffect(() => { if (pageId) void loadPage(pageId); }, [pageId, loadPage]);

  function addBlock(type: string) {
    const entry = library.find((item) => item.type === type);
    if (!entry) return;
    const block = { ...entry.template, id: `${type}-${Math.random().toString(36).slice(2, 8)}` } as SiteBlock;
    setBlocks((current) => [...current, block]);
    setSelected(block.id);
  }

  function updateBlock(id: string, patch: Partial<SiteBlock>) {
    setBlocks((current) => current.map((block) => (block.id === id ? ({ ...block, ...patch } as SiteBlock) : block)));
  }

  function moveBlock(index: number, direction: -1 | 1) {
    setBlocks((current) => {
      const next = [...current];
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item!);
      return next;
    });
  }

  function onDrop(targetIndex: number) {
    if (dragging === null) return;
    setBlocks((current) => {
      const next = [...current];
      const [item] = next.splice(dragging, 1);
      next.splice(targetIndex, 0, item!);
      return next;
    });
    setDragging(null);
  }

  async function saveDraft() {
    setBusy(true); setMessage(null); setError(null);
    try {
      await api.saveDraft(pageId, title, blocks);
      setMessage('Draft saved.');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function publish() {
    setBusy(true); setMessage(null); setError(null);
    const validation = parseSitePage({ title, blocks });
    if (!validation.ok) { setError(validation.error); setBusy(false); return; }
    try {
      const result = await api.publishPage(pageId, title, blocks);
      setMessage(result.message);
      await loadPages();
      await loadPage(pageId);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function rollback(versionId: string) {
    setBusy(true); setMessage(null); setError(null);
    try {
      const result = await api.rollbackPage(pageId, versionId);
      setMessage(result.message);
      await loadPage(pageId);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function createPage(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage(null); setError(null);
    try {
      const result = await api.createPage(newSlug, newTitle);
      setMessage(`Page /${result.slug} created.`);
      setNewSlug(''); setNewTitle('');
      await loadPages();
      setPageId(result.id);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  const selectedBlock = blocks.find((block) => block.id === selected) as (SiteBlock & Row) | undefined;

  return (
    <div className="stack" style={{ gap: '1.25rem' }}>
      <div className="page-head">
        <div>
          <h1>Site builder</h1>
          <p>Compose public pages from validated blocks. No user-supplied script or style is ever executed.</p>
        </div>
        <div className="row">
          <select value={pageId} onChange={(event) => setPageId(event.target.value)} aria-label="Select page">
            {pages.map((page) => <option key={String(page.id)} value={String(page.id)}>{String(page.slug)} — {String(page.title)}</option>)}
          </select>
          <button type="button" className="btn secondary" onClick={() => void saveDraft()} disabled={busy || !pageId}>Save draft</button>
          <button type="button" className="btn" onClick={() => void publish()} disabled={busy || !pageId}>Publish</button>
        </div>
      </div>

      {message && <Notice tone="success">{message}</Notice>}
      {error && <Notice tone="critical">{error}</Notice>}

      {!pageId ? <Loading label="Loading pages…" /> : (
        <>
          <Field label="Page title"><input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} /></Field>
          <p className="subtle">Public URL: <span className="mono">/{slug}</span></p>

          <Tabs tabs={[{ id: 'edit', label: 'Edit' }, { id: 'preview', label: 'Preview' }, { id: 'versions', label: 'Versions' }]} active={tab} onChange={(id) => setTab(id as 'edit' | 'preview' | 'versions')} />

          {tab === 'edit' && (
            <div className="builder">
              <aside className="builder-palette">
                <h3>Blocks</h3>
                <p className="subtle" style={{ fontSize: '0.8rem' }}>Drag a block onto the canvas, or click to append.</p>
                {library.map((entry) => (
                  <div
                    key={entry.type}
                    className="block-item"
                    draggable
                    onDragStart={(event) => { event.dataTransfer.setData('text/plain', entry.type); setDragging(blocks.length); }}
                    onClick={() => addBlock(entry.type)}
                    title={entry.description}
                  >
                    <span className="handle">⋮⋮</span>
                    <span>{entry.label}</span>
                  </div>
                ))}
                <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '0.9rem 0' }} />
                <h3>New page</h3>
                <form onSubmit={createPage} className="stack" style={{ gap: '0.4rem' }}>
                  <Field label="Slug"><input required value={newSlug} onChange={(event) => setNewSlug(event.target.value)} placeholder="how-it-works" maxLength={60} /></Field>
                  <Field label="Title"><input required value={newTitle} onChange={(event) => setNewTitle(event.target.value)} maxLength={160} /></Field>
                  <button className="btn secondary small" type="submit" disabled={busy}>Create page</button>
                </form>
              </aside>

              <div className="builder-canvas" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
                event.preventDefault();
                const type = event.dataTransfer.getData('text/plain');
                if (type) addBlock(type);
                setDragging(null);
              }}>
                {blocks.length === 0 && <Empty>Drag a block here to start building the page.</Empty>}
                {blocks.map((block, index) => (
                  <div
                    key={block.id}
                    className={`block-item${selected === block.id ? ' selected' : ''}${dragging === index ? ' dragging' : ''}`}
                    draggable
                    onDragStart={() => setDragging(index)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => onDrop(index)}
                    onClick={() => setSelected(block.id)}
                  >
                    <span className="handle">⋮⋮</span>
                    <span className="grow">
                      <strong>{block.type}</strong> <span className="subtle">— {String((block as Row).title || (block as Row).label || block.id)}</span>
                    </span>
                    <button type="button" className="btn secondary small" onClick={(event) => { event.stopPropagation(); moveBlock(index, -1); }} aria-label="Move up">↑</button>
                    <button type="button" className="btn secondary small" onClick={(event) => { event.stopPropagation(); moveBlock(index, 1); }} aria-label="Move down">↓</button>
                    <button type="button" className="btn danger small" onClick={(event) => { event.stopPropagation(); setBlocks((current) => current.filter((item) => item.id !== block.id)); }} aria-label="Remove block">×</button>
                  </div>
                ))}
              </div>

              <aside className="builder-inspector">
                <h3>Block settings</h3>
                {!selectedBlock ? (
                  <p className="muted">Select a block to edit its fields.</p>
                ) : (
                  <div className="stack" style={{ gap: '0.4rem' }}>
                    {Object.entries(selectedBlock).filter(([key]) => key !== 'id' && key !== 'type').map(([key, value]) => {
                      if (typeof value === 'boolean') {
                        return (
                          <label className="checkbox" key={key}>
                            <input type="checkbox" checked={value} onChange={(event) => updateBlock(selectedBlock.id, { [key]: event.target.checked } as Partial<SiteBlock>)} />
                            <span>{key}</span>
                          </label>
                        );
                      }
                      if (typeof value === 'number') {
                        return (
                          <Field key={key} label={key}>
                            <input type="number" value={value} onChange={(event) => updateBlock(selectedBlock.id, { [key]: Number(event.target.value) } as Partial<SiteBlock>)} />
                          </Field>
                        );
                      }
                      if (key === 'items' && Array.isArray(value)) {
                        return (
                          <Field key={key} label={key} hint="One entry per line, as title|body for cards.">
                            <textarea
                              rows={5}
                              value={value.map((item) => (typeof item === 'object' && item ? `${(item as Row).title || ''}|${(item as Row).body || ''}` : String(item))).join('\n')}
                              onChange={(event) => updateBlock(selectedBlock.id, {
                                items: event.target.value.split('\n').filter(Boolean).map((line) => {
                                  const [itemTitle, ...rest] = line.split('|');
                                  return { title: itemTitle || '', body: rest.join('|'), icon: 'chart' };
                                }),
                              } as Partial<SiteBlock>)}
                            />
                          </Field>
                        );
                      }
                      if (Array.isArray(value)) {
                        return (
                          <Field key={key} label={key} hint="Comma separated.">
                            <input value={value.join(',')} onChange={(event) => updateBlock(selectedBlock.id, { [key]: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) } as Partial<SiteBlock>)} />
                          </Field>
                        );
                      }
                      return (
                        <Field key={key} label={key}>
                          <input value={String(value ?? '')} onChange={(event) => updateBlock(selectedBlock.id, { [key]: event.target.value } as Partial<SiteBlock>)} />
                        </Field>
                      );
                    })}
                  </div>
                )}
              </aside>
            </div>
          )}

          {tab === 'preview' && (
            <Card title="Preview" subtitle="This is the same block renderer the public page uses">
              {blocks.length ? <BlockPreview blocks={blocks} /> : <Empty>Nothing to preview yet.</Empty>}
            </Card>
          )}

          {tab === 'versions' && (
            <Card title="Published versions">
              {versions.length ? (
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>Version</th><th>Title</th><th>Published</th><th /></tr></thead>
                    <tbody>
                      {versions.map((version) => (
                        <tr key={String(version.id)}>
                          <td>{String(version.version)}</td>
                          <td>{String(version.title)}</td>
                          <td className="nowrap">{version.publishedAt ? new Date(String(version.publishedAt)).toLocaleString() : 'draft'}</td>
                          <td>
                            <button type="button" className="btn secondary small" onClick={() => void rollback(String(version.id))} disabled={busy}>Roll back</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <Empty>This page has no versions yet.</Empty>}
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function BlockPreview({ blocks }: { blocks: SiteBlock[] }) {
  return <BlockRenderer blocks={blocks as unknown as Array<Record<string, unknown>>} />;
}
