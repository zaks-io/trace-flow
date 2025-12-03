import Link from 'next/link';

export default function Home() {
  return (
    <div>
      <h1>Trace Flow</h1>
      <p>LLM Request Analytics Platform</p>
      <Link href="/app">Go to Dashboard</Link>
    </div>
  );
}
