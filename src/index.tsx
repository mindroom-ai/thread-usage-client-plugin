import type { ClientPlugin } from '@mindroom/client-sdk/core';
import { en } from './strings';
import { ThreadCardUsage } from './ThreadCardUsage';
import { threadHasUsage } from './threadUsage';
import { ThreadUsageDetails } from './ThreadUsageDetails';
import './styles.css';

const plugin: ClientPlugin = {
  threadCardBadges: [{ Component: ThreadCardUsage }],
  threadDetails: [{ shows: threadHasUsage, Component: ThreadUsageDetails }],
  translations: { en },
};

export default plugin;
