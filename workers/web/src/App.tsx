import { Route, Switch } from 'wouter';
import Index from './pages/Index';
import AppLayout from './pages/AppLayout';

export default function App() {
  return (
    <Switch>
      <Route path="/" component={Index} />
      <Route path="/app/:rest*" component={AppLayout} />
    </Switch>
  );
}
