import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="flex flex-col justify-center text-center flex-1 px-4">
      <h1 className="text-3xl font-bold mb-4">🌋 Alchemy</h1>
      <p className="text-fd-muted-foreground mb-6">
        Golden Sun: The Broken Seal and The Lost Age, written out again as readable C that builds back into the
        original games byte for byte.
      </p>
      <p className="flex gap-4 justify-center">
        <Link href="/docs" className="font-medium underline">
          Introduction
        </Link>
        <Link href="/docs/tbs" className="font-medium underline">
          The Broken Seal
        </Link>
        <Link href="/docs/tla" className="font-medium underline">
          The Lost Age
        </Link>
        <Link href="/docs/reference" className="font-medium underline">
          Reference
        </Link>
      </p>
    </div>
  );
}
