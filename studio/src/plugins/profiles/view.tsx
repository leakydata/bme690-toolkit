import { registerView } from '../registry.ts';

function View() {
  return <div className="pagehead"><h1>Heater profiles</h1><p>Coming soon.</p></div>;
}

registerView({ id: 'profiles', title: 'Heater profiles', hint: 'Design .bmeconfig files', order: 50, needsProject: true, component: View });
