/** Schema tool (OpenAI function calling format) yang diekspos ke LLM. */
export const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description:
        'List isi sebuah folder di dalam project (maksimal kedalaman 3 level). Path relatif terhadap root project, kosongkan untuk root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path folder relatif, contoh: "src" atau ""' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Baca isi sebuah file di dalam project.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path file relatif, contoh: "src/index.js"' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Tulis file (buat baru atau timpa). Folder otomatis dibuat kalau belum ada.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path file relatif' },
          content: { type: 'string', description: 'Isi lengkap file' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Edit file dengan mengganti satu string persis dengan string baru. old_string harus unik di dalam file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string', description: 'Teks lama yang dicari (harus unik)' },
          new_string: { type: 'string', description: 'Teks pengganti' }
        },
        required: ['path', 'old_string', 'new_string']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Jalankan shell command di dalam workspace project (misal npm install, npm test, python main.py). Timeout 2 menit.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command yang dijalankan' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Tampilkan status working tree git (file yang berubah).',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_commit',
      description: 'Stage semua perubahan dan buat commit.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Commit message' }
        },
        required: ['message']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_push',
      description: 'Push commit ke remote GitHub.',
      parameters: { type: 'object', properties: {} }
    }
  }
];

/** Tool yang read-only: di mode ASK tidak perlu konfirmasi user. */
export const READONLY_TOOLS = new Set(['list_files', 'read_file', 'git_status']);
