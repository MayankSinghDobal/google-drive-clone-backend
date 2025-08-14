import express from 'express';
import { supabase } from './supabaseClient';

const app = express();
const port = 3000;

app.get('/', (req, res) => {
  res.send('Hello, Google Drive Clone Backend!');
});
app.get('/test-db', async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('*').limit(1);
    if (error) throw error;
    res.send({ message: 'Connected to Supabase!', data });
  } catch (error) {
    res.status(500).send({ message: 'Connection failed', error });
  }
});
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});