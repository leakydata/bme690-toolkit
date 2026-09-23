/**
 * Registers the built-in model kinds. Import this once (the Train view does)
 * before listing kinds or loading a saved model. Each kind is its own file
 * calling registerModelKind(); add a new one by adding a file and a line here.
 */
import './mlp.ts';
import './forest.ts';
import './knn.ts';
