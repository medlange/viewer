// SPDX-License-Identifier: Apache-2.0
/* The analyze action: the study-screen verb that opens the analyze dialog.
 *
 * Registered as an ACTION contribution -- the first of its kind, and deliberately a
 * trivial one: the value is the seam, not this verb. A third-party action is a module
 * that calls register() the way this file does; the shell renders every registered
 * ACTION on the study bar and hands it the context it cannot reach without importing
 * the shell (the open study, the reload). That is the V1 extension point the roadmap
 * names, proven on a real feature before it is offered to anyone else.
 */
import { KINDS, register } from '../core/registry.js';
import { t } from '../core/i18n.js';
import { openAnalyzeDialog } from './ai-dialog.js';

export default register({
  id: 'analyze',
  kind: KINDS.ACTION,
  order: 10,
  title: t('ai.action', 'Analyze'),
  // NO GLYPH YET: `iconButton` falls back to the title text, which is also the honest
  // state of the verb -- an icon can arrive later without this file changing.
  icon: null,
  onClick({ studyUid, reloadStudy } = {}) {
    if (!studyUid) return;
    openAnalyzeDialog({ studyUid, onDone: reloadStudy });
  },
});
