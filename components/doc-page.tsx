import { DocsBody, DocsPage, DocsTitle, MarkdownCopyButton, PageLastUpdate, ViewOptionsPopover } from 'fumadocs-ui/layouts/spacious/page';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import { Lightbox } from 'fumadocs-ui/components/image-zoom';
import { unstable_notFound } from 'waku/router/server';
import { getMDXComponents } from '@/components/mdx';
import { PageCards } from '@/components/page-cards';
import { TOCDropdown, TOCPopover } from '@/components/toc-popover';
import { TOC, TOCProvider } from 'fumadocs-ui/layouts/spacious/page/slots/toc';
import { appName, gitConfig, isList, siteUrl } from '@/lib/shared';
import { markdownUrl, ogImage, source } from '@/lib/source';

// A page of the site (src/pages/index.tsx and src/pages/[...slugs].tsx), in
// the sidebar src/pages/_layout.tsx gives every page, with its title and
// preview image (lib/og.tsx) for links to it elsewhere.
export async function DocPage({ slugs }: { slugs: string[] }) {
  const page = source.getPage(slugs);
  if (!page) unstable_notFound();

  const { body: MDX, toc: fullToc } = await page.data.load();
  // A reference page lists its sections, not its hundreds of members.
  const toc = isList(page.url) ? fullToc.filter((t) => t.depth <= 2) : fullToc;
  const github = page.data.source && `https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/${page.data.source}`;
  const title = slugs.length ? `${page.data.title} | ${appName}` : appName;
  const image = `${siteUrl}${ogImage(page)}`;
  return (
    <>
      <title>{title}</title>
      {page.data.description && <meta name="description" content={page.data.description} />}
      <meta property="og:title" content={title} />
      {page.data.description && <meta property="og:description" content={page.data.description} />}
      <meta property="og:image" content={image} />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={title} />
      {page.data.description && <meta name="twitter:description" content={page.data.description} />}
      <meta name="twitter:image" content={image} />
      <DocsPage toc={toc} full={page.data.full} slots={{ toc: { provider: TOCProvider, main: TOC, popover: TOCPopover, dropdown: TOCDropdown } }}>
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
        {page.data.lastModified && <PageLastUpdate date={new Date(page.data.lastModified)} />}
      </DocsPage>
    </>
  );
}
