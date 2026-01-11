'use client';

import { useParams } from 'next/navigation';
import Requests from '@/components/pages/Requests';

export default function RequestsPage() {
  const params = useParams();
  const traceId = params.traceId?.[0];
  return <Requests traceId={traceId} />;
}
