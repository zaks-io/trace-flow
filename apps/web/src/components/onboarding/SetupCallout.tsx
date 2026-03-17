'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type SetupCalloutProps = {
  title: string;
  description: string;
  primaryHref?: string;
  primaryLabel?: string;
  secondaryHref?: string;
  secondaryLabel?: string;
};

export function SetupCallout({
  title,
  description,
  primaryHref = '/app',
  primaryLabel = 'Open getting started',
  secondaryHref,
  secondaryLabel,
}: SetupCalloutProps) {
  return (
    <Card className="mx-auto max-w-2xl border-dashed bg-card/60 text-left shadow-none">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-3">
        <Button asChild>
          <Link href={primaryHref}>
            <span>{primaryLabel}</span>
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
        {secondaryHref && secondaryLabel ? (
          <Button asChild variant="outline">
            <Link href={secondaryHref}>{secondaryLabel}</Link>
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
