import express from 'express';
import { supabase } from './supabaseClient';
import dotenv from 'dotenv';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { authMiddleware } from './authMiddleware';
import multer from 'multer';
import NodeCache from 'node-cache';

const cache = new NodeCache({ stdTTL: 300, checkperiod: 120 }); // 5-minute TTL, check every 2 minutes

dotenv.config();
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
const port = 3000;

app.use(express.json());

// Performance monitoring middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - ${duration}ms`);
  });
  next();
});

app.get('/', (req, res) => {
  res.send('Hello, Google Drive Clone Backend!');
});

app.get('/test-db', async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('*').limit(1);
    if (error) {
      console.error('Supabase error:', error);
      throw error;
    }
    console.log('Supabase data:', data);
    res.send({ message: 'Connected to Supabase!', data });
  } catch (error) {
    console.error('Connection failed:', error);
    res.status(500).send({ error: 'Connection failed', error });
  }
});

app.post('/signup', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const { data, error } = await supabase
      .from('users')
      .insert([{ email, password: hashedPassword }])
      .select();
    if (error) {
      console.error('Signup error:', error);
      return res.status(400).json({ error: error.message });
    }
    res.status(201).json({ message: 'User created', user: data[0] });
  } catch (error) {
    console.error('Signup failed:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();
    if (error || !data) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const isValidPassword = await bcrypt.compare(password, data.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = jwt.sign(
      { userId: data.id, email: data.email },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' }
    );
    res.json({ message: 'Login successful', token });
  } catch (error) {
    console.error('Login failed:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/auth/google', async (req, res) => {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: 'http://localhost:3000/auth/google/callback',
    },
  });
  if (error) {
    console.error('Google OAuth error:', error);
    return res.status(500).json({ error: 'Failed to initiate Google OAuth' });
  }
  res.redirect(data.url);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).json({ error: 'No code provided' });
  }
  try {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code as string);
    if (error) {
      console.error('Callback error:', error);
      return res.status(500).json({ error: 'Failed to exchange code' });
    }
    const token = jwt.sign(
      { userId: data.user.id, email: data.user.email },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' }
    );
    res.json({ message: 'Google login successful', token });
  } catch (error) {
    console.error('Callback failed:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/protected', authMiddleware, (req, res) => {
  res.json({ message: 'This is a protected route', user: (req as any).user });
});

app.post('/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const user = (req as any).user;
    const { parentFolderPath } = req.body;
    const fileName = `${Date.now()}_${req.file.originalname}`;
    const filePath = parentFolderPath ? `${parentFolderPath}/${fileName}` : `${user.userId}/${fileName}`;

    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('files')
      .upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype,
      });

    if (uploadError) {
      console.error('Upload error:', uploadError);
      return res.status(500).json({ error: 'Failed to upload file' });
    }

    const { data, error } = await supabase
      .from('files_folders')
      .insert([
        {
          user_id: user.userId,
          name: req.file.originalname,
          path: filePath,
          type: 'file',
          parent_path: parentFolderPath || null,
        },
      ])
      .select();

    if (error) {
      console.error('Metadata error:', error);
      return res.status(500).json({ error: 'Failed to save file metadata' });
    }

    const { data: publicUrlData } = supabase.storage
      .from('files')
      .getPublicUrl(filePath);

    res.json({ message: 'File uploaded', file: data[0], url: publicUrlData.publicUrl });
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/files', authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const cacheKey = `files_${user.userId}`;

    const cachedData = cache.get(cacheKey);
    if (cachedData) {
      return res.json({ message: 'Items listed', items: cachedData });
    }

    const { data, error } = await supabase
      .from('files_folders')
      .select('*')
      .eq('user_id', user.userId)
      .eq('is_deleted', false);

    if (error) {
      console.error('List error:', error);
      return res.status(500).json({ error: 'Failed to list items' });
    }

    cache.set(cacheKey, data);
    res.json({ message: 'Items listed', items: data });
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/download/:fileName', authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const fileName = `${user.userId}/${req.params.fileName}`;
    const { data, error } = await supabase.storage
      .from('files')
      .createSignedUrl(fileName, 60); // 60 seconds

    if (error) {
      console.error('Download error:', error);
      return res.status(500).json({ error: 'Failed to generate download URL' });
    }

    res.json({ message: 'Download URL generated', url: data.signedUrl });
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/delete/:fileId', authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const { fileId } = req.params;

    const { data, error } = await supabase
      .from('files_folders')
      .update({ is_deleted: true })
      .eq('id', fileId)
      .eq('user_id', user.userId)
      .select();

    if (error || !data.length) {
      console.error('Soft delete error:', error);
      return res.status(404).json({ error: 'File or folder not found' });
    }

    res.json({ message: 'Moved to trash', item: data[0] });
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/trash', authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const { data, error } = await supabase
      .from('files_folders')
      .select('*')
      .eq('user_id', user.userId)
      .eq('is_deleted', true);

    if (error) {
      console.error('Trash list error:', error);
      return res.status(500).json({ error: 'Failed to list trashed items' });
    }

    res.json({ message: 'Trashed items listed', items: data });
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/restore/:fileId', authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const { fileId } = req.params;

    const { data, error } = await supabase
      .from('files_folders')
      .update({ is_deleted: false })
      .eq('id', fileId)
      .eq('user_id', user.userId)
      .select();

    if (error || !data.length) {
      console.error('Restore error:', error);
      return res.status(404).json({ error: 'File or folder not found in trash' });
    }

    res.json({ message: 'Restored from trash', item: data[0] });
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/share/:fileId', authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const { fileId } = req.params;

    const { data: fileData, error: fileError } = await supabase
      .from('files_folders')
      .select('path, type')
      .eq('id', fileId)
      .eq('user_id', user.userId)
      .single();

    if (fileError || !fileData) {
      console.error('File fetch error:', fileError);
      return res.status(404).json({ error: 'File or folder not found' });
    }

    const path = fileData.type === 'folder' ? `${fileData.path}/.keep` : fileData.path;

    const { data, error } = await supabase.storage
      .from('files')
      .createSignedUrl(path, 604800); // 7 days

    if (error) {
      console.error('Signed URL error:', error);
      return res.status(500).json({ error: 'Failed to generate share link' });
    }

    res.json({ message: 'Share link generated', url: data.signedUrl });
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/rename/:fileName', authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const { newFileName } = req.body;
    if (!newFileName) {
      return res.status(400).json({ error: 'New file name is required' });
    }
    const oldFileName = `${user.userId}/${req.params.fileName}`;
    const newFilePath = `${user.userId}/${newFileName}`;
    const { data, error } = await supabase.storage
      .from('files')
      .move(oldFileName, newFilePath);

    if (error) {
      console.error('Rename error:', error);
      return res.status(500).json({ error: 'Failed to rename file' });
    }

    res.json({ message: 'File renamed', data });
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.route('/permissions/:fileId')
  .post(authMiddleware, async (req, res) => {
    try {
      const user = (req as any).user;
      const { fileId } = req.params;
      const { user_id: targetUserId, role } = req.body;

      if (!targetUserId || !role || !['owner', 'editor', 'viewer'].includes(role)) {
        return res.status(400).json({ error: 'Valid user_id and role (owner/editor/viewer) are required' });
      }

      const { data, error } = await supabase
        .from('permissions')
        .insert([{ file_id: fileId, user_id: targetUserId, role }])
        .select();

      if (error) {
        console.error('Permission add error:', error);
        return res.status(400).json({ error: error.message });
      }

      res.json({ message: 'Permission added', permission: data[0] });
    } catch (error) {
      console.error('Server error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  })
  .put(authMiddleware, async (req, res) => {
    try {
      const user = (req as any).user;
      const { fileId } = req.params;
      const { user_id: targetUserId, role } = req.body;

      if (!targetUserId || !role || !['owner', 'editor', 'viewer'].includes(role)) {
        return res.status(400).json({ error: 'Valid user_id and role (owner/editor/viewer) are required' });
      }

      const { data, error } = await supabase
        .from('permissions')
        .update({ role })
        .eq('file_id', fileId)
        .eq('user_id', targetUserId)
        .select();

      if (error || !data.length) {
        console.error('Permission update error:', error);
        return res.status(404).json({ error: 'Permission not found' });
      }

      res.json({ message: 'Permission updated', permission: data[0] });
    } catch (error) {
      console.error('Server error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  })
  .delete(authMiddleware, async (req, res) => {
    try {
      const user = (req as any).user;
      const { fileId } = req.params;
      const { user_id: targetUserId } = req.body;

      if (!targetUserId) {
        return res.status(400).json({ error: 'Valid user_id is required' });
      }

      const { data, error } = await supabase
        .from('permissions')
        .delete()
        .eq('file_id', fileId)
        .eq('user_id', targetUserId)
        .select();

      if (error || !data.length) {
        console.error('Permission delete error:', error);
        return res.status(404).json({ error: 'Permission not found' });
      }

      res.json({ message: 'Permission removed', permission: data[0] });
    } catch (error) {
      console.error('Server error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });

app.get('/search', authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const { query, page = 1, limit = 10 } = req.query;

    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'Search query is required' });
    }

    const offset = (Number(page) - 1) * Number(limit);
    const cacheKey = `search_${user.userId}_${query}_${page}_${limit}`;

    const cachedData = cache.get(cacheKey);
    if (cachedData) {
      return res.json(cachedData);
    }

    const { data, error, count } = await supabase
      .from('files_folders')
      .select('*', { count: 'exact' })
      .eq('user_id', user.userId)
      .eq('is_deleted', false)
      .ilike('name', `%${query}%`)
      .or(`path.ilike.%${query}%`)
      .range(offset, offset + Number(limit) - 1);

    if (error) {
      console.error('Search error:', error);
      return res.status(500).json({ error: 'Failed to search items' });
    }

    const response = {
      message: 'Search results',
      items: data,
      total: count,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(count / Number(limit))
    };
    cache.set(cacheKey, response);
    res.json(response);
  } catch (error) {
    console.error('Server error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});