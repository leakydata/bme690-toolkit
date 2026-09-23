/**
 * Every feature of the studio is registered here. To add one, create a file
 * that calls registerView() (or another register function) and import it
 * below. The order of imports does not matter; `order` decides placement.
 */
// Feature sets and model kinds, before any page that lists or runs them.
import '../ml/models/index.ts';

import './projects/view.tsx';
import './data/view.tsx';
import './explore/view.tsx';
import './train/view.tsx';
import './live/view.tsx';
import './profiles/view.tsx';
