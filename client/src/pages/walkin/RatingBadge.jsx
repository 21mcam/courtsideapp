// First-screen social proof: "★ 5.0 (205 Google reviews)". The funnel
// audit showed rating-next-to-name converts trust early, so this is a
// first-class element on the service list, not a footer afterthought.
//
// Renders nothing unless BOTH rating and review count are set (a
// rating with no count reads fake; a count with no rating reads
// broken). Links to the tenant's Google reviews page when provided.

import { Star } from 'lucide-react';
import { useAuth } from '../../auth.jsx';

export default function RatingBadge() {
  const { tenant } = useAuth();
  const rating = tenant.google_rating;
  const count = tenant.google_review_count;
  if (rating == null || count == null || count <= 0) return null;

  const body = (
    <>
      <Star size={16} className="fill-amber-400 text-amber-400" aria-hidden />
      <span className="font-semibold text-slate-900">
        {Number(rating).toFixed(1)}
      </span>
      <span className="text-slate-500">
        ({count.toLocaleString('en-US')} Google reviews)
      </span>
    </>
  );

  const className = 'mt-1 inline-flex items-center gap-1.5 text-sm';
  if (tenant.google_reviews_url) {
    return (
      <a
        href={tenant.google_reviews_url}
        target="_blank"
        rel="noreferrer"
        className={`${className} hover:underline`}
      >
        {body}
      </a>
    );
  }
  return <div className={className}>{body}</div>;
}
