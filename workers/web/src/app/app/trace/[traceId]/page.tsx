'use client';

import { useParams } from 'next/navigation';
import TraceDetail from '@/components/pages/TraceDetail';

export default function TraceDetailPage() {
  const params = useParams();
  const traceId = params.traceId as string;
  return <TraceDetail traceId={traceId} />;
}
