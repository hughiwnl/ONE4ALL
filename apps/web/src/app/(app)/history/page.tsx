import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { formatDate } from '@/lib/format';
import { getContainer } from '@/server/container';
import { getCurrentUser } from '@/server/session';
import { PostSummaryRow } from './post-summary-row';

export const metadata = { title: 'History' };

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const { cursor } = await searchParams;
  const { items, nextCursor } = await getContainer().services.posts.list(user.id, {
    limit: 20,
    cursor,
  });

  return (
    <>
      <PageHeader title="History" description="Every post and how each destination fared." />
      <Card>
        {items.length === 0 ? (
          <CardBody>
            <p className="text-sm text-neutral-500">
              No posts yet.{' '}
              <Link href="/publish" className="text-brand-600 hover:underline">
                Publish your first video
              </Link>
              .
            </p>
          </CardBody>
        ) : (
          <ul className="divide-y divide-neutral-200">
            {items.map((post) => (
              <PostSummaryRow key={post.id} post={post} subtitle={formatDate(post.createdAt)} />
            ))}
          </ul>
        )}
      </Card>
      {nextCursor ? (
        <div className="mt-4 flex justify-center">
          <Link href={`/history?cursor=${encodeURIComponent(nextCursor)}`}>
            <Button variant="secondary">Older posts</Button>
          </Link>
        </div>
      ) : null}
    </>
  );
}
