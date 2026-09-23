import { registerView } from '../registry.ts';

function View() {
  return <div className="pagehead"><h1>Live</h1><p>Coming soon.</p></div>;
}

registerView({ id: 'live', title: 'Live', hint: 'Board over USB', order: 40, needsProject: true, component: View });
