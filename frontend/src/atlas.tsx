import React from 'react';
import {createRoot} from 'react-dom/client';
import App from './Application';
import './map-mock.css';
import './atlas-live.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><App atlas/></React.StrictMode>);

import './atlas-migration.css';
import './atlas-chat.css';
