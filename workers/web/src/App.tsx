import { Route, Switch } from 'wouter';
import Index from './pages/Index';
import AppPage from './pages/AppPage';

export default function App() {
  return (
    <Switch>
      <Route path="/" component={Index} />
      <Route path="/app" component={AppPage} />
    </Switch>
  );
}
