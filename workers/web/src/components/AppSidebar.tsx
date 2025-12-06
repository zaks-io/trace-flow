import { useLocation, Link } from 'react-router-dom';
import { useAuth0 } from '@auth0/auth0-react';
import {
  LayoutDashboard,
  Activity,
  GitBranch,
  Key,
  LogOut,
  LogIn,
  User,
  Zap,
  BookOpen,
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

const navItems = [
  { title: 'Dashboard', to: '/', icon: LayoutDashboard },
  { title: 'Requests', to: '/requests', icon: Activity },
  { title: 'Traces', to: '/traces', icon: GitBranch },
  { title: 'API Keys', to: '/api-keys', icon: Key },
  { title: 'Docs', to: '/docs', icon: BookOpen, external: true },
];

export function AppSidebar() {
  const location = useLocation();
  const pathname = location.pathname;
  const { isAuthenticated, isLoading, loginWithRedirect, logout, user } = useAuth0();

  const isActive = (to: string) => {
    if (to === '/') {
      return pathname === '/';
    }
    return pathname.startsWith(to);
  };

  return (
    <Sidebar className="border-r border-sidebar-border/50">
      <SidebarHeader className="border-b border-sidebar-border/50 px-4 py-4">
        <Link to="/" className="flex items-center gap-3 transition-opacity hover:opacity-80">
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
                <SidebarMenuItem
                  key={item.to}
                  className="animate-fade-in"
                  style={{ animationDelay: `${index * 50}ms` }}
                >
                  <SidebarMenuButton
                    asChild
                    isActive={isActive(item.to)}
                    tooltip={item.title}
                    className="h-10 gap-3 rounded-lg px-3 transition-all duration-200 hover:bg-sidebar-accent data-[active=true]:bg-primary/10 data-[active=true]:text-primary"
                  >
                    {item.external ? (
                      <a href={item.to}>
                        <item.icon
                          className={`h-4 w-4 transition-colors ${isActive(item.to) ? 'text-primary' : 'text-muted-foreground'}`}
                        />
                        <span
                          className={`font-medium ${isActive(item.to) ? 'text-primary' : 'text-foreground'}`}
                        >
                          {item.title}
                        </span>
                      </a>
                    ) : (
                      <Link to={item.to}>
                        <item.icon
                          className={`h-4 w-4 transition-colors ${isActive(item.to) ? 'text-primary' : 'text-muted-foreground'}`}
                        />
                        <span
                          className={`font-medium ${isActive(item.to) ? 'text-primary' : 'text-foreground'}`}
                        >
                          {item.title}
                        </span>
                      </Link>
                    )}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="mt-auto px-2 pb-4">
        <SidebarSeparator className="mb-4 opacity-50" />
        <SidebarMenu>
          {isLoading ? (
            <SidebarMenuItem>
              <SidebarMenuButton disabled className="h-10 gap-3 px-3">
                <div className="h-4 w-4 animate-pulse rounded-full bg-muted" />
                <span className="text-muted-foreground">Loading...</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : isAuthenticated ? (
            <>
              <SidebarMenuItem>
                <div className="flex items-center gap-3 rounded-lg bg-sidebar-accent/50 px-3 py-2.5">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 ring-1 ring-primary/20">
                    <User className="h-4 w-4 text-primary" />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium text-foreground">
                      {user?.name ?? 'User'}
                    </span>
                    {user?.email && (
                      <span className="truncate text-xs text-muted-foreground">{user.email}</span>
                    )}
                  </div>
                </div>
              </SidebarMenuItem>
              <SidebarMenuItem className="mt-1">
                <SidebarMenuButton
                  onClick={() => {
                    void logout({ logoutParams: { returnTo: window.location.origin } });
                  }}
                  className="h-9 gap-3 rounded-lg px-3 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                >
                  <LogOut className="h-4 w-4" />
                  <span className="text-sm font-medium">Sign out</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </>
          ) : (
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => {
                  void loginWithRedirect({
                    authorizationParams: {
                      redirect_uri:
                        typeof window !== 'undefined' ? `${window.location.origin}/app` : '',
                    },
                  });
                }}
                className="h-10 gap-3 rounded-lg bg-primary px-3 text-primary-foreground transition-all hover:bg-primary/90 hover:shadow-lg hover:shadow-primary/20"
              >
                <LogIn className="h-4 w-4" />
                <span className="font-medium">Sign in</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
