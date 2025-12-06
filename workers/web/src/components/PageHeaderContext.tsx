'use client';

import * as React from 'react';

export interface PageHeaderAction {
  id: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  onClick?: () => void;
  href?: string;
  variant?: 'default' | 'destructive';
  disabled?: boolean;
}

interface PageHeaderContextValue {
  title: string;
  setTitle: (title: string) => void;
  actions: PageHeaderAction[];
  setActions: (actions: PageHeaderAction[]) => void;
}

const PageHeaderContext = React.createContext<PageHeaderContextValue | null>(null);

export function PageHeaderProvider({ children }: { children: React.ReactNode }) {
  const [title, setTitle] = React.useState('');
  const [actions, setActions] = React.useState<PageHeaderAction[]>([]);

  const value = React.useMemo(
    () => ({
      title,
      setTitle,
      actions,
      setActions,
    }),
    [title, actions],
  );

  return <PageHeaderContext.Provider value={value}>{children}</PageHeaderContext.Provider>;
}

export function usePageHeaderContext() {
  const context = React.useContext(PageHeaderContext);
  if (!context) {
    throw new Error('usePageHeaderContext must be used within a PageHeaderProvider.');
  }
  return context;
}

export function usePageHeader(title: string, actions?: PageHeaderAction[]) {
  const { setTitle, setActions } = usePageHeaderContext();

  React.useEffect(() => {
    setTitle(title);
    return () => setTitle('');
  }, [title, setTitle]);

  React.useEffect(() => {
    setActions(actions ?? []);
    return () => setActions([]);
  }, [actions, setActions]);
}
