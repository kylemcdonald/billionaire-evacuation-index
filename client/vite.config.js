import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function inlineEntryBootstrap() {
  return {
    name: 'inline-entry-bootstrap',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const htmlAsset = Object.values(bundle).find(
        (asset) => asset.type === 'asset' && asset.fileName === 'index.html',
      )
      const entryChunks = Object.values(bundle).filter(
        (asset) => asset.type === 'chunk' && asset.isEntry,
      )

      if (!htmlAsset || entryChunks.length === 0) {
        return
      }

      let html = String(htmlAsset.source)

      for (const entryChunk of entryChunks) {
        const preloadDependencies = getPreloadDependencies(entryChunk, bundle)
        let entryCode = entryChunk.code.replaceAll(
          '__VITE_PRELOAD__',
          JSON.stringify(preloadDependencies),
        )

        for (const dynamicImport of entryChunk.dynamicImports ?? []) {
          const importedFileName = dynamicImport.split('/').at(-1)

          entryCode = entryCode
            .replaceAll(`import(\`./${importedFileName}\`)`, `import(\`/${dynamicImport}\`)`)
            .replaceAll(`import("./${importedFileName}")`, `import("/${dynamicImport}")`)
            .replaceAll(`import('./${importedFileName}')`, `import('/${dynamicImport}')`)
        }

        const escapedFileName = entryChunk.fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const scriptTagPattern = new RegExp(
          `<script\\b(?=[^>]*\\btype=["']module["'])(?=[^>]*\\bsrc=["']/${escapedFileName}["'])[^>]*></script>`,
        )

        if (scriptTagPattern.test(html)) {
          html = html.replace(scriptTagPattern, `<script type="module">\n${entryCode}\n</script>`)
          delete bundle[entryChunk.fileName]
        }
      }

      htmlAsset.source = html
    },
  }
}

function getPreloadDependencies(entryChunk, bundle) {
  const dependencies = []
  const seenDependencies = new Set()
  const seenChunks = new Set()

  function addDependency(fileName) {
    if (seenDependencies.has(fileName)) {
      return
    }

    seenDependencies.add(fileName)
    dependencies.push(fileName)
  }

  function addChunk(fileName) {
    if (seenChunks.has(fileName)) {
      return
    }

    seenChunks.add(fileName)
    addDependency(fileName)

    const chunk = bundle[fileName]

    if (!chunk || chunk.type !== 'chunk') {
      return
    }

    for (const importedFileName of chunk.imports ?? []) {
      addChunk(importedFileName)
    }

    for (const cssFileName of chunk.viteMetadata?.importedCss ?? []) {
      addDependency(cssFileName)
    }
  }

  for (const dynamicImport of entryChunk.dynamicImports ?? []) {
    addChunk(dynamicImport)
  }

  return dependencies
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), inlineEntryBootstrap()],
  server: {
    proxy: {
      '/api': 'http://localhost:3030',
    },
  },
})
