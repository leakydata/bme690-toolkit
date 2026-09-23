import { registerView } from '../registry.ts';

function View() {
  return <div className="pagehead"><h1>Explore</h1><p>Coming soon.</p></div>;
}

registerView({ id: 'explore', title: 'Explore', hint: 'Graphs, fingerprints, maps', order: 20, needsProject: true, component: View });
