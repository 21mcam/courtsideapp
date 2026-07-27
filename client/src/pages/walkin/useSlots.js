// Merged slot fetching for the walk-in + manage flows: one
// /api/availability call per candidate resource, merged with
// mergeAvailability ("No preference" = union of start times, concrete
// resource chosen emptiest-first at submit). Extracted from the old
// WalkInPage effect so the manage/reschedule page can reuse it
// verbatim.

import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { ANY_RESOURCE, mergeAvailability } from '../../lib/availability.js';

export function useSlots({ offeringId, resources, resourceId, date, nonce = 0 }) {
  const [slots, setSlots] = useState(null);
  const [reason, setReason] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  // start ISO → resource ids that had that slot, booking-preference
  // ordered (lib/availability.js).
  const [resourceIdsBySlot, setResourceIdsBySlot] = useState({});

  const resourceKey = (resources ?? []).map((r) => r.id).join(',');

  useEffect(() => {
    if (!offeringId || !resourceId || !date) {
      setSlots(null);
      setReason(null);
      setResourceIdsBySlot({});
      return undefined;
    }
    const candidateIds =
      resourceId === ANY_RESOURCE
        ? (resources ?? []).map((r) => r.id)
        : [resourceId];
    if (candidateIds.length === 0) {
      setSlots([]);
      setReason(null);
      setResourceIdsBySlot({});
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setReason(null);
    Promise.all(
      candidateIds.map((rid) =>
        api(
          `/api/availability?offering_id=${offeringId}&resource_id=${rid}&date=${date}`,
        ).then(async (res) => {
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || `HTTP ${res.status}`);
          }
          return res.json();
        }),
      ),
    )
      .then((results) => {
        if (cancelled) return;
        const merged = mergeAvailability(candidateIds, results);
        setSlots(merged.slots);
        setReason(merged.reason);
        setResourceIdsBySlot(merged.resourceIdsBySlot);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // resourceKey stands in for the resources array identity.
  }, [offeringId, resourceId, resourceKey, date, nonce]);

  return { slots, reason, error, loading, resourceIdsBySlot };
}
