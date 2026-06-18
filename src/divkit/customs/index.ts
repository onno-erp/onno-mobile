// Register every onno-* custom renderer. Import for side effects once at app
// start (the divkit barrel does this). Covers the full set the web UI package
// implements, so any page the server composes renders natively.
import { registerCustom } from '../registry';
import { onnoActions } from './actions';
import { onnoActionsMenu } from './actionsMenu';
import { onnoComments } from './comments';
import { onnoConstants } from './constants';
import { onnoForm } from './form';
import { onnoGeo } from './geo';
import { onnoHint, onnoIcon } from './icon';
import { onnoList } from './list';
import { onnoLoginForm } from './loginForm';
import { onnoWidget } from './widget';

registerCustom('onno-icon', onnoIcon);
registerCustom('onno-hint', onnoHint);
registerCustom('onno-widget', onnoWidget);
registerCustom('onno-list', onnoList);
registerCustom('onno-actions-menu', onnoActionsMenu);
registerCustom('onno-actions', onnoActions);
registerCustom('onno-form', onnoForm);
registerCustom('onno-comments', onnoComments);
registerCustom('onno-constants', onnoConstants);
registerCustom('onno-login-form', onnoLoginForm);
registerCustom('onno-geo', onnoGeo);
