import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    // 原生依赖（sharp/onnxruntime-node）必须外部化，运行时从 node_modules 加载，避免相对路径找不到 .node 绑定
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: 'src/main/index.ts',
          // 独立子进程入口，见 src/main/ai/workerClient.ts 里的 fork() 调用
          'ai-worker': 'src/main/ai/worker.ts'
        }
      }
    }
  },
preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: 'src/preload/index.ts',
          photopea: 'src/preload/photopea.ts'
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [vue()],
    build: {
      rollupOptions: {
        input: {
          index: 'src/renderer/index.html',
          'photopea-host': 'src/renderer/photopea-host.html'
        }
      }
    }
  }
})
