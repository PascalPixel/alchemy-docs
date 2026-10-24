import { DocsBody, DocsPage, DocsTitle, MarkdownCopyButton, ViewOptionsPopover } from 'fumadocs-ui/layouts/docs/page';
import { notFound } from 'next/navigation';
import { getMDXComponents } from '@/components/mdx';
import type { Metadata } from 'next';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import { Lightbox } from 'fumadocs-ui/components/image-zoom';
import { TOCPopover } from '@/components/toc-popover';
import { PageCards } from '@/components/page-cards';
import { gitConfig, isList } from '@/lib/shared';
import { markdownUrl, ogImage, source } from '@/lib/source';

export default async function Page(props: PageProps<'/[[...slug]]'>) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  // A reference page lists its sections, not its hundreds of members.
  const toc = isList(page.url) ? page.data.toc.filter((t) => t.depth <= 2) : page.data.toc;
  const github = page.data.source && `https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/${page.data.source}`;
  return (
    <DocsPage toc={toc} full={page.data.full} tableOfContentPopover={{ component: <TOCPopover /> }}>
      <DocsTitle>{page.data.title}</DocsTitle>
      {/* Where the page comes from, and its Markdown to copy or open elsewhere. */}
      <div className="flex flex-row flex-wrap items-center gap-2 border-b pb-6 text-sm text-fd-muted-foreground">
        {github && (
          <a href={github} className="me-auto">
            {page.data.source} on GitHub
          </a>
        )}
        <MarkdownCopyButton markdownUrl={markdownUrl(page)} />
        <ViewOptionsPopover markdownUrl={markdownUrl(page)} githubUrl={github} />
      </div>
      <DocsBody>
        {/* Every picture on the page can be enlarged, and swiped through in one viewer. */}
        <Lightbox>
          <MDX
            components={getMDXComponents({
              // this allows you to link to other pages with relative file paths
              a: createRelativeLink(source, page),
            })}
          />
        </Lightbox>
        {!isList(page.url) && <PageCards url={page.url} />}
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: PageProps<'/[[...slug]]'>): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
    openGraph: { images: ogImage(page) },
    twitter: { card: 'summary_large_image', images: ogImage(page) },
  };
}
