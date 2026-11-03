import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { SessionRoute } from './routes/SessionRoute';
import { LinkRoute } from './routes/LinkRoute';
import { IntentRoute } from './routes/IntentRoute';
import { EmbedRoute } from './routes/EmbedRoute';
import { NotFoundRoute } from './routes/NotFoundRoute';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/c/:sessionId" element={<SessionRoute />} />
        <Route path="/l/:linkId" element={<LinkRoute />} />
        <Route path="/i/:intentId" element={<IntentRoute />} />
        <Route path="/embed/:sessionId" element={<EmbedRoute />} />
        <Route path="*" element={<NotFoundRoute />} />
      </Routes>
    </BrowserRouter>
  );
}
