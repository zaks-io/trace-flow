'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Activity,
  GitBranch,
  Key,
  Bell,
  LogOut,
  User,
  Zap,
  BookOpen,
  UserPlus,
  Shield,
  CreditCard,
  ChartColumn,
  Layers,
  Bot,
  MessageSquare,
} from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from '@/components/ui/sidebar';
import { EmailContactLink } from '@/components/shared/EmailContactLink';
import { FeedbackDialog } from '@/components/FeedbackDialog';

interface NavItem {
  title: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

const navItems: NavItem[] = [
  { title: 'Dashboard', href: '/app', icon: LayoutDashboard },
  { title: 'Operations', href: '/app/operations', icon: Layers },
  { title: 'Agents', href: '/app/agents', icon: Bot },
  { title: 'Requests', href: '/app/requests', icon: Activity },
  { title: 'Traces', href: '/app/traces', icon: GitBranch },
  { title: 'Docs', href: '/docs', icon: BookOpen },
];

const settingsItems: NavItem[] = [
  { title: 'Billing', href: '/app/settings/billing', icon: CreditCard },
  { title: 'API Keys', href: '/app/api-keys', icon: Key },
  { title: 'Alerts', href: '/app/alerts', icon: Bell },
];

const adminNavItems: NavItem[] = [
  { title: 'System', href: '/app/admin', icon: Shield },
  { title: 'Analytics', href: '/app/admin/analytics', icon: ChartColumn },
  { title: 'Invites', href: '/app/admin/invites', icon: UserPlus },
];

function NavMenuItem({ item, active, delay }: { item: NavItem; active: boolean; delay?: number }) {
  return (
    <SidebarMenuItem
      className="animate-fade-in"
      style={delay ? { animationDelay: `${delay}ms` } : undefined}
    >
      <SidebarMenuButton
        asChild
        isActive={active}
        tooltip={item.title}
        className="h-10 gap-3 rounded-lg px-3 transition-all duration-200 hover:bg-sidebar-accent data-[active=true]:bg-primary/10 data-[active=true]:text-primary"
      >
        <Link href={item.href}>
          <item.icon
            className={`h-4 w-4 transition-colors ${active ? 'text-primary' : 'text-muted-foreground'}`}
          />
          <span className={`font-medium ${active ? 'text-primary' : 'text-foreground'}`}>
            {item.title}
          </span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function AppSidebar({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  const isActive = (href: string) => {
    if (href === '/app' || href === '/app/admin') {
      return pathname === href;
    }
    return pathname.startsWith(href);
  };

  return (
    <Sidebar variant="inset" className="border-none bg-transparent">
      <SidebarHeader className="px-4 py-6">
        <Link href="/app" className="flex items-center gap-3 transition-opacity hover:opacity-80">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 ring-1 ring-primary/20">
            <Zap className="h-5 w-5 text-primary" />
          </div>
          <div className="flex flex-col">
            <span className="text-base font-semibold tracking-tight text-foreground">
              Trace Flow
            </span>
            <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
              LLM Analytics
            </span>
          </div>
        </Link>
      </SidebarHeader>

      <SidebarContent className="overflow-x-hidden px-2 py-4">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu className="space-y-1">
              {navItems.map((item, index) => (
                <NavMenuItem
                  key={item.href}
                  item={item}
                  active={isActive(item.href)}
                  delay={index * 50}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator className="my-2 opacity-50" />
        <SidebarGroup>
          <p className="px-3 pb-1 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
            Settings
          </p>
          <SidebarGroupContent>
            <SidebarMenu className="space-y-1">
              {settingsItems.map((item) => (
                <NavMenuItem key={item.href} item={item} active={isActive(item.href)} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {isAdmin && (
          <>
            <SidebarSeparator className="my-2 opacity-50" />
            <SidebarGroup>
              <p className="px-3 pb-1 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                Admin
              </p>
              <SidebarGroupContent>
                <SidebarMenu className="space-y-1">
                  {adminNavItems.map((item) => (
                    <NavMenuItem key={item.href} item={item} active={isActive(item.href)} />
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </>
        )}
      </SidebarContent>

      <SidebarFooter className="mt-auto px-2 pb-4">
        <SidebarSeparator className="mb-4 opacity-50" />
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="flex items-center gap-3 rounded-lg bg-sidebar-accent/50 px-3 py-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 ring-1 ring-primary/20">
                <User className="h-4 w-4 text-primary" />
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium text-foreground">User</span>
              </div>
            </div>
          </SidebarMenuItem>
          <SidebarMenuItem className="mt-1">
            <div className="rounded-lg px-3 py-2 text-sm text-muted-foreground">
              Need help?{' '}
              <EmailContactLink
                localPart="support"
                domainParts={['trace-flow', 'dev']}
                label="Contact Trace Flow support"
                className="h-auto p-0 text-sm font-medium text-foreground decoration-foreground/50 hover:text-primary hover:decoration-primary"
              />
            </div>
          </SidebarMenuItem>
          <SidebarMenuItem className="mt-1">
            <SidebarMenuButton
              className="h-9 gap-3 rounded-lg px-3 text-muted-foreground transition-colors hover:bg-sidebar-accent"
              onClick={() => setFeedbackOpen(true)}
              tooltip="Send Feedback"
            >
              <MessageSquare className="h-4 w-4" />
              <span className="text-sm font-medium">Feedback</span>
            </SidebarMenuButton>
            <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
          </SidebarMenuItem>
          <SidebarMenuItem className="mt-1">
            <SidebarMenuButton
              asChild
              className="h-9 gap-3 rounded-lg px-3 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            >
              <a href="/auth/logout">
                <LogOut className="h-4 w-4" />
                <span className="text-sm font-medium">Sign out</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem className="mt-1">
            <div className="flex gap-3 px-3 py-1 text-xs text-muted-foreground/60">
              <Link href="/terms" className="transition-colors hover:text-foreground">
                Terms
              </Link>
              <Link href="/privacy" className="transition-colors hover:text-foreground">
                Privacy
              </Link>
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
