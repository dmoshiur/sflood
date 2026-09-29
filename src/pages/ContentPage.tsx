/**
 * Public page for schema-driven site content: renders the published revision
 * for /page/:slug (the target of the Hackeradmin site-editor "Publish" action).
 * With no published revision it says so honestly instead of showing filler.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { getPublicContent } from '../adminApi';
import { ContentBlocks, type ContentBlockData } from '../components/ContentBlocks';

export function ContentPage() {
  const { slug = '' } = useParams();
  const [title, setTitle] = useState('');
  const [blocks, setBlocks] = useState<ContentBlockData[] | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    setBlocks(null); setMissing(false); setTitle('');
    getPublicContent(slug)
      .then((payload) => { setTitle(payload.page.title); setBlocks(payload.page.content.blocks as unknown as ContentBlockData[]); })
      .catch(() => setMissing(true));
  }, [slug]);

  return <main className="page content-public-page">
    <Link className="cb-back" to="/"><ArrowLeft size={14} /> Back to the project</Link>
    {blocks === null && !missing && <p className="empty-note">Loading published content…</p>}
    {missing && <section className="cb-empty">
      <h1>Nothing published here yet</h1>
      <p>Site editors can compose and publish this page from <strong>Hackeradmin → Site tools</strong>. Only published revisions appear publicly — nothing is shown until then.</p>
      <Link className="cb-button cb-button-primary" to="/status">Open live status</Link>
    </section>}
    {blocks !== null && <>
      {title && <h1 className="content-public-title">{title}</h1>}
      <ContentBlocks blocks={blocks} />
    </>}
  </main>;
}

export default ContentPage;
