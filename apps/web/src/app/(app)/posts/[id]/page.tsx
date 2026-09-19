import { notFound, redirect } from 'next/navigation';
import { isAppError } from '@repeat/core';
import { PageHeader } from '@/components/app-shell';
import { describeMedia } from '@/components/media-thumb';
import { getContainer } from '@/server/container';
import { getCurrentUser } from '@/server/session';
import { PostStatusView } from './post-status-view';

export const metadata = { title: 'Post status' };

export default async function PostPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const { id } = await params;
  let post;
  try {
    post = await getContainer().services.posts.get(user.id, id);
  } catch (error) {
    if (isAppError(error) && error.status === 404) notFound();
    throw error;
  }
  return (
    <>
      <PageHeader
        title={post.title || describeMedia(post.mediaItems)}
        description={`Publishing ${post.mediaItems.length > 1 ? `a carousel of ${post.mediaItems.length} items` : post.media.filename} to ${post.destinations.length} destination${post.destinations.length === 1 ? '' : 's'}`}
      />
      <PostStatusView initialPost={post} />
    </>
  );
}
