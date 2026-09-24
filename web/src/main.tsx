import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.tsx';
import './styles.css';

const client = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => {
        const status = (error as unknown as { status?: number }).status ?? 0;
        return count < 2 && !(status > 0 && status < 500);
      },
      refetchOnWindowFocus: true,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
