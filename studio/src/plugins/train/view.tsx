import { registerView } from '../registry.ts';

function View() {
  return <div className="pagehead"><h1>Train</h1><p>Coming soon.</p></div>;
}

registerView({ id: 'train', title: 'Train', hint: 'Models and testing', order: 30, needsProject: true, component: View });
