'use client';

import { createContext, useContext } from 'react';

const AdminContext = createContext(false);

export const AdminProvider = AdminContext.Provider;

export const useIsAdmin = () => useContext(AdminContext);
