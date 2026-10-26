export const dynamic = 'force-dynamic';

// Keep next dev on the same response implementation as the Worker fast path.
export { healthResponse as GET, healthResponse as HEAD } from '../../health';
