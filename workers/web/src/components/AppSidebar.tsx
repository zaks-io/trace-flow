'use client';

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
  DollarSign,
  UserPlus,
  Shield,
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

interface NavItem {
  title: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

const navItems: NavItem[] = [
  { title: 'Dashboard', href: '/app', icon: LayoutDashboard },
  { title: 'Usage', href: '/app/usage', icon: DollarSign },
  { title: 'Requests', href: '/app/requests', icon: Activity },
  { title: 'Traces', href: '/app/traces', icon: GitBranch },
  { title: 'API Keys', href: '/app/api-keys', icon: Key },
  { title: 'Alerts', href: '/app/alerts', icon: Bell },
  { title: 'Docs', href: '/docs', icon: BookOpen },
];

const adminNavItems: NavItem[] = [
  { title: 'System', href: '/app/admin', icon: Shield },
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

  const isActive = (href: string) => {
    if (href === '/app' || href === '/app/admin') {
      return pathname === href;
    }
    return pathname.startsWith(href);
  };

  return (
    <Sidebar className="border-r border-sidebar-border/50">
      <SidebarHeader className="border-b border-sidebar-border/50 px-4 py-4">
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

      <SidebarContent className="px-2 py-4">
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

        {isAdmin && (
          <>
            <SidebarSeparator className="mx-2 my-2 opacity-50" />
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
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
