import { createContext } from 'react';
export const VisionChangesContext = createContext({ newIds: new Set(), changedIds: new Set() });
