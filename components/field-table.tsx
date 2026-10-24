import { TypeTable, type TypeNode } from 'fumadocs-ui/components/type-table';
import { Children, isValidElement, type ReactNode } from 'react';

type FieldProps = { name: string; type: string; href?: string; children?: ReactNode };

// One field of a structure; FieldTable reads it, and it draws nothing itself.
export function Field(_: FieldProps) {
  return null;
}

// A structure's fields (lib/remark-components.ts) as fumadocs' TypeTable:
// each row its name and type, opening on its ///< note and a link to its
// entry further down the page.
export function FieldTable({ children }: { children: ReactNode }) {
  const type: Record<string, TypeNode> = {};
  for (const child of Children.toArray(children)) {
    if (!isValidElement<FieldProps>(child)) continue;
    const { name, type: t, href, children: about } = child.props;
    type[name] = {
      type: <code>{t}</code>,
      // A narrow table hides the type column; an opened row shows it.
      typeDescription: <code>{t}</code>,
      required: true,
      description: (
        <>
          {about}
          {href && (
            <>
              {' '}
              <a href={href}>More…</a>
            </>
          )}
        </>
      ),
    };
  }
  return <TypeTable type={type} />;
}
