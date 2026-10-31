// dsh-skills-manager browser client half — hand-written in the DeepSeek Harness
// ModuleLoader format (no bundler needed). Declared via package.json `dsh.client`
// and exported as `./client`; the harness serves this file and registers it.
//
// UI: a "Skills" page in Settings (`settings.section`, id `skills`, order 40).
//   - Installed: every skill discovered in the local skill roots, grouped by root,
//     with a monogram row per skill, writable-only Edit/Delete, a conflict banner
//     above the list, search, and a stat strip.
//   - Available: configured skill libraries (Install / Update / Installed, force
//     install for shadowing conflicts) plus a read-only "From plugins" catalog.
//   - Add/Edit: inline editor card with debounced live /validate, field errors,
//     blocking-conflict handling, a force-save limited to duplicate/alias
//     conflicts, and a status line reporting whether agents can see the skill.
//
// Rules honoured here (see CONTRACT.md "Client UI"):
//   - inject = ['slots']; every other service is read through ctx.get() and
//     null-checked. Reading a non-injected service as a property throws, so this
//     file never reads the locale or sessions services as properties.
//   - One <style> element injected via ctx.effect (classes prefixed dsm-, all
//     selectors scoped under .dsm-root). Host theme tokens only; light and dark
//     are both served by the tokens.
//   - The API is same-origin fetch against `/skills-manager` with
//     credentials: 'same-origin'. Non-2xx JSON envelopes are parsed regardless of
//     response.ok so validation errors/conflicts reach the form.
//   - All visible copy (including aria labels) comes from the en/zh dictionaries.
window.__ModuleLoader__.load({
  id: '@stijnus/dsh-skills-manager',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')
    var h = React.createElement

    var name = 'skills-manager-client'
    var inject = ['slots']
    // The settings locale namespace. Declared on the slot registration only when
    // the host installed a locale face; the dictionaries are registered there too.
    var NS = 'settings.skills'
    var API_BASE = '/skills-manager'
    var STYLE_ID = 'dsm-styles'
    var VALIDATE_DEBOUNCE_MS = 350
    var NAME_MAX = 64
    var DESCRIPTION_MAX = 1024
    var WHEN_MAX = 512
    var FORCEABLE_CONFLICTS = { 'duplicate-name': true, 'alias-collision': true }

    // -----------------------------------------------------------------------
    // Dictionaries — every visible string, including aria labels, lives here.
    // `en` is also the fallback used when the host supplies no locale service.
    // -----------------------------------------------------------------------
    var en = {
      'section.label': 'Skills',
      'section.eyebrow': 'Agent skills',
      'section.subtitle': 'Install, add, edit, and validate the skills agents can load.',

      'stats.installed': 'Installed',
      'stats.available': 'Available',
      'stats.conflicts': 'Conflicts',

      'action.add': 'Add skill',
      'action.refresh': 'Refresh',
      'action.retry': 'Retry',
      'action.cancel': 'Cancel',
      'action.save': 'Save',
      'action.saving': 'Saving…',
      'action.edit': 'Edit',
      'action.delete': 'Delete',
      'action.deleting': 'Deleting…',
      'action.install': 'Install',
      'action.installing': 'Installing…',
      'action.update': 'Update',
      'action.replace': 'Replace',
      'action.replacing': 'Replacing…',
      'action.installAnyway': 'Install anyway',
      'action.dismiss': 'Dismiss',
      'action.clearSearch': 'Clear search',

      'tab.installed': 'Installed',
      'tab.available': 'Available',

      'search.label': 'Search skills',
      'search.placeholder': 'Search by name or description',
      'search.empty': 'No skills match your search.',
      'search.emptyHint': 'Try a different name, or clear the search.',

      'loading': 'Loading skills…',
      'refreshing': 'Refreshing…',

      'error.title': 'Could not load skills',
      'error.load': 'The skills API did not return the expected state.',
      'error.http': 'The skills API returned HTTP {status}.',
      'error.network': 'The request failed before it reached the skills API.',
      'error.saveFailed': 'The skill could not be saved.',
      'error.deleteFailed': 'The skill could not be deleted.',
      'error.installFailed': 'The skill could not be installed.',
      'error.loadSkill': 'This skill could not be read from disk.',
      'error.action': 'The action failed.',

      'empty.installed': 'No skills found in the scanned roots.',
      'empty.installedHint': 'Add a skill, or install one from the Available tab.',

      'badge.bundle': 'bundle',
      'badge.flat': 'flat',
      'badge.model': 'model',
      'badge.user': 'user',
      'badge.hidden': 'hidden',
      'badge.rank': 'rank {rank}',
      'badge.conflict': 'conflict',
      'badge.invalid': 'invalid',
      'badge.update': 'update',
      'badge.installed': 'installed',
      'badge.readonly': 'Read-only',

      'row.noDescription': 'No description.',

      'conflict.title': 'Skill conflicts',
      'conflict.hint': 'These skills shadow each other, so agents may load the wrong one.',
      'conflict.error': 'Error',
      'conflict.warning': 'Warning',
      'conflict.kind.duplicate': 'Duplicate name',
      'conflict.kind.alias': 'Alias collision',
      'conflict.kind.overlap': 'Description overlap',
      'conflict.entries': 'In {roots}',
      'conflict.sharedWords': 'Shared words: {words}',

      'available.libraries': 'Libraries',
      'available.librariesHint': 'Skill packs configured for this plugin.',
      'available.plugins': 'From plugins',
      'available.pluginsHint': 'Skills served by installed plugins — read-only here.',
      'available.pluginsHostScope': 'The host-scope registry cannot verify a session catalog; local skill changes reach agents on their next step through the filesystem provider.',
      'available.emptyTitle': 'Nothing available yet',
      'available.emptyBody': 'Add a skill-pack directory to the plugin libraries config to install skills from it.',
      'available.libraryMissing': 'Library path not found: {path}',
      'available.libraryMissingBadge': 'missing',
      'available.libraryEmpty': 'No skills were found in this library.',
      'available.pluginsEmpty': 'All plugin skills are already on disk.',
      'available.catalogUnavailable': 'The live skill catalog is unavailable.',
      'available.installedIn': 'in {root}',
      'available.confirmUpdate': 'This replaces the installed copy.',
      'available.installConflict': 'A read-only root already has this name, so the installed copy will be shadowed.',
      'available.count': '{count} skills',
      'available.countOne': '{count} skill',
      'catalog.provider': 'via {provider}',

      'editor.newTitle': 'Add a skill',
      'editor.editTitle': 'Edit skill',
      'editor.newSubtitle': 'Writes a SKILL.md into the writable root.',
      'editor.editSubtitle': 'Saves atomically; external edits are never silently overwritten.',
      'editor.loading': 'Reading this skill…',
      'editor.errorsTitle': 'Errors',
      'editor.conflictsTitle': 'Blocking conflicts',
      'editor.warningsTitle': 'Warnings',
      'editor.forceOnly': 'Only duplicate-name or alias-collision conflicts can be forced.',
      'editor.noWritableRoots': 'No writable skill root is configured, so skills cannot be created here.',
      'editor.fixErrors': 'Fix the errors below before saving.',
      'editor.checking': 'Checking…',
      'editor.valid': 'Looks good.',
      'editor.invalid': 'Not ready to save.',

      'field.name': 'Name',
      'field.nameHint': 'Lowercase letters, digits, and single dashes.',
      'field.nameLocked': 'The name of an existing skill cannot be changed.',
      'field.description': 'Description',
      'field.descriptionHint': 'What the skill does. Agents read this to decide whether to load it.',
      'field.descriptionPlaceholder': 'Describe what this skill helps agents do.',
      'field.whenToUse': 'When to use (optional)',
      'field.whenToUseHint': 'Situations or prompts that should trigger this skill.',
      'field.whenToUsePlaceholder': 'Use when…',
      'field.body': 'Instructions (Markdown)',
      'field.bodyHint': 'The instruction body. Leave empty to write frontmatter only.',
      'field.bodyPlaceholder': 'Write the skill instructions here.',
      'field.root': 'Root',
      'field.kind': 'Format',
      'field.kindHint': 'Bundle folders can ship resources; flat files are a single Markdown file.',
      'field.kindBundle': 'Bundle folder',
      'field.kindFlat': 'Single file',
      'field.invocation': 'Invocation',
      'field.modelInvocable': 'Model can invoke this skill',
      'field.userInvocable': 'User can invoke this skill',
      'field.force': 'Save even though another skill uses this name',
      'field.forceHint': 'The other copies stay on disk; the lower rank wins.',
      'field.counter': '{current} / {max}',

      'status.saved': 'Saved · agents can see it now.',
      'status.savedNotVisible': "Saved, but the agent catalog hasn't shown it yet; it can take a moment.",
      'status.savedNoRegistry': 'Saved · the host cannot observe the session catalog from here. The filesystem provider watches this root, so agents pick it up on their next step.',
      'status.refreshed': 'Refreshed.',
      'status.deleted': 'Deleted "{name}".',
      'status.installed': 'Installed "{name}".',
      'status.updated': 'Updated "{name}".',

      'delete.confirm': 'Delete "{name}"? This removes the file(s).',

      'aria.section': 'Skills manager',
      'aria.summary': 'Skills summary',
      'aria.views': 'Skill views',
      'aria.add': 'Add a new skill',
      'aria.refresh': 'Refresh skills',
      'aria.edit': 'Edit {name}',
      'aria.delete': 'Delete {name}',
      'aria.install': 'Install {name}',
      'aria.update': 'Update {name}',
      'aria.installAnyway': 'Install {name} anyway',
      'aria.dismiss': 'Dismiss message',
      'aria.library': 'Library {label}',
      'aria.deleteConfirmActions': 'Delete confirmation for {name}',
      'aria.confirmDelete': 'Confirm deleting {name}',
      'aria.updateConfirmActions': 'Update confirmation for {name}',
    }

    var zh = {
      'section.label': '技能',
      'section.eyebrow': '智能体技能',
      'section.subtitle': '安装、添加、编辑并校验智能体可加载的技能。',

      'stats.installed': '已安装',
      'stats.available': '可安装',
      'stats.conflicts': '冲突',

      'action.add': '添加技能',
      'action.refresh': '刷新',
      'action.retry': '重试',
      'action.cancel': '取消',
      'action.save': '保存',
      'action.saving': '正在保存…',
      'action.edit': '编辑',
      'action.delete': '删除',
      'action.deleting': '正在删除…',
      'action.install': '安装',
      'action.installing': '正在安装…',
      'action.update': '更新',
      'action.replace': '替换',
      'action.replacing': '正在替换…',
      'action.installAnyway': '仍然安装',
      'action.dismiss': '关闭',
      'action.clearSearch': '清除搜索',

      'tab.installed': '已安装',
      'tab.available': '可安装',

      'search.label': '搜索技能',
      'search.placeholder': '按名称或描述搜索',
      'search.empty': '没有匹配搜索的技能。',
      'search.emptyHint': '试试其他名称，或清除搜索。',

      'loading': '正在加载技能…',
      'refreshing': '正在刷新…',

      'error.title': '无法加载技能',
      'error.load': '技能 API 未返回预期的状态。',
      'error.http': '技能 API 返回了 HTTP {status}。',
      'error.network': '请求未能到达技能 API。',
      'error.saveFailed': '无法保存该技能。',
      'error.deleteFailed': '无法删除该技能。',
      'error.installFailed': '无法安装该技能。',
      'error.loadSkill': '无法从磁盘读取该技能。',
      'error.action': '操作失败。',

      'empty.installed': '在已扫描的根目录中未找到技能。',
      'empty.installedHint': '请添加技能，或从「可安装」页安装一个。',

      'badge.bundle': '目录',
      'badge.flat': '单文件',
      'badge.model': '模型可调用',
      'badge.user': '用户可调用',
      'badge.hidden': '隐藏',
      'badge.rank': 'rank {rank}',
      'badge.conflict': '冲突',
      'badge.invalid': '无效',
      'badge.update': '有更新',
      'badge.installed': '已安装',
      'badge.readonly': '只读',

      'row.noDescription': '暂无描述。',

      'conflict.title': '技能冲突',
      'conflict.hint': '这些技能会相互遮蔽，智能体可能加载到错误的一个。',
      'conflict.error': '错误',
      'conflict.warning': '警告',
      'conflict.kind.duplicate': '重名',
      'conflict.kind.alias': '别名冲突',
      'conflict.kind.overlap': '描述重叠',
      'conflict.entries': '位于 {roots}',
      'conflict.sharedWords': '共同词：{words}',

      'available.libraries': '技能库',
      'available.librariesHint': '为此插件配置的技能包。',
      'available.plugins': '来自插件',
      'available.pluginsHint': '由已安装插件提供的技能，此处只读。',
      'available.pluginsHostScope': '宿主作用域的注册表无法校验会话目录；本地技能更改会在下一步通过文件系统提供方提供给智能体。',
      'available.emptyTitle': '暂无可安装的技能',
      'available.emptyBody': '在插件的技能库配置中添加一个技能包目录，即可从中安装技能。',
      'available.libraryMissing': '技能库路径不存在：{path}',
      'available.libraryMissingBadge': '缺失',
      'available.libraryEmpty': '此技能库中未找到技能。',
      'available.pluginsEmpty': '插件技能均已在磁盘上。',
      'available.catalogUnavailable': '实时技能目录不可用。',
      'available.installedIn': '位于 {root}',
      'available.confirmUpdate': '这会替换已安装的副本。',
      'available.installConflict': '只读根目录中已存在同名技能，安装后的副本会被遮蔽。',
      'available.count': '{count} 个技能',
      'available.countOne': '{count} 个技能',
      'catalog.provider': '来自 {provider}',

      'editor.newTitle': '添加技能',
      'editor.editTitle': '编辑技能',
      'editor.newSubtitle': '将把 SKILL.md 写入可写的根目录。',
      'editor.editSubtitle': '原子写入；不会静默覆盖外部修改。',
      'editor.loading': '正在读取该技能…',
      'editor.errorsTitle': '错误',
      'editor.conflictsTitle': '阻断性冲突',
      'editor.warningsTitle': '警告',
      'editor.forceOnly': '只有重名或别名冲突可以选择强制保存。',
      'editor.noWritableRoots': '未配置可写的技能根目录，因此无法在此创建技能。',
      'editor.fixErrors': '请先修复下方错误再保存。',
      'editor.checking': '正在检查…',
      'editor.valid': '校验通过。',
      'editor.invalid': '暂时无法保存。',

      'field.name': '名称',
      'field.nameHint': '小写字母、数字和单个连字符。',
      'field.nameLocked': '现有技能的名称不可更改。',
      'field.description': '描述',
      'field.descriptionHint': '技能的作用，智能体据此决定是否加载。',
      'field.descriptionPlaceholder': '描述这个技能能帮助智能体做什么。',
      'field.whenToUse': '使用时机（可选）',
      'field.whenToUseHint': '应触发此技能的场景或提示。',
      'field.whenToUsePlaceholder': '当……时使用',
      'field.body': '指令正文（Markdown）',
      'field.bodyHint': '指令正文；留空则只写入 frontmatter。',
      'field.bodyPlaceholder': '在这里编写技能指令。',
      'field.root': '根目录',
      'field.kind': '格式',
      'field.kindHint': '目录（bundle）可以携带资源；单文件（flat）只是一个 Markdown 文件。',
      'field.kindBundle': '目录（bundle）',
      'field.kindFlat': '单文件（flat）',
      'field.invocation': '调用方式',
      'field.modelInvocable': '允许模型调用此技能',
      'field.userInvocable': '允许用户调用此技能',
      'field.force': '即使其他技能同名也保存',
      'field.forceHint': '其他副本仍保留在磁盘上；rank 更低者生效。',
      'field.counter': '{current} / {max}',

      'status.saved': '已保存 · 智能体现在可以看到它。',
      'status.savedNotVisible': '已保存，但智能体目录尚未显示它；可能需要一点时间。',
      'status.savedNoRegistry': '已保存 · 宿主无法从这里观察会话技能目录。文件系统提供方会监听该根目录，智能体将在下一步获取到它。',
      'status.refreshed': '已刷新。',
      'status.deleted': '已删除“{name}”。',
      'status.installed': '已安装“{name}”。',
      'status.updated': '已更新“{name}”。',

      'delete.confirm': '删除“{name}”？这会移除相关文件。',

      'aria.section': '技能管理器',
      'aria.summary': '技能概览',
      'aria.views': '技能视图',
      'aria.add': '添加新技能',
      'aria.refresh': '刷新技能',
      'aria.edit': '编辑 {name}',
      'aria.delete': '删除 {name}',
      'aria.install': '安装 {name}',
      'aria.update': '更新 {name}',
      'aria.installAnyway': '仍然安装 {name}',
      'aria.dismiss': '关闭消息',
      'aria.library': '技能库 {label}',
      'aria.deleteConfirmActions': '{name} 的删除确认',
      'aria.confirmDelete': '确认删除 {name}',
      'aria.updateConfirmActions': '{name} 的更新确认',
    }

    // -----------------------------------------------------------------------
    // Small pure helpers
    // -----------------------------------------------------------------------
    function hasOwn(obj, key) {
      return Object.prototype.hasOwnProperty.call(obj, key)
    }

    function merged(base, extra) {
      for (var key in extra) if (hasOwn(extra, key)) base[key] = extra[key]
      return base
    }

    function isArray(value) {
      return Object.prototype.toString.call(value) === '[object Array]'
    }

    function arr(value) {
      return isArray(value) ? value : []
    }

    function str(value) {
      return typeof value === 'string' ? value : ''
    }

    function interpolate(text, params) {
      if (!params) return text
      return text.replace(/\{([a-zA-Z0-9_]+)\}/g, function (match, key) {
        return hasOwn(params, key) ? String(params[key]) : match
      })
    }

    /** Local fallback translator: en dictionary, host-locale aware when present. */
    function fallbackTranslate(key, params) {
      var base = hasOwn(en, key) ? en[key] : key
      return params === undefined ? base : interpolate(base, params)
    }

    /** Build the render-time translator: prefer the slot seat, then the live face. */
    function tOf(props, translate) {
      var seat = props && typeof props.t === 'function' ? props.t : null
      if (seat === null) return translate || fallbackTranslate
      return function (key, params) {
        var text
        try {
          text = params === undefined ? seat(key) : seat(key, params)
        } catch (error) {
          text = key
        }
        if (typeof text !== 'string' || text === key) {
          return (translate || fallbackTranslate)(key, params)
        }
        return text
      }
    }

    function envelopeMessage(body) {
      if (!body || typeof body !== 'object') return ''
      if (body.error && typeof body.error.message === 'string' && body.error.message) return body.error.message
      if (typeof body.message === 'string' && body.message) return body.message
      var errors = arr(body.errors)
      for (var i = 0; i < errors.length; i++) {
        if (errors[i] && typeof errors[i].message === 'string' && errors[i].message) return errors[i].message
      }
      return ''
    }

    /** Friendly network error text; keeps a short technical detail when present. */
    function networkMessage(error, tr) {
      var base = tr('error.network')
      var detail = error && typeof error.message === 'string' ? error.message : ''
      if (detail && detail !== 'fetch unavailable') return base + ' ' + detail
      return base
    }

    function readJsonResponse(response) {
      return response.text().then(function (text) {
        var body = null
        if (text) {
          try {
            body = JSON.parse(text)
          } catch (error) {
            body = null
          }
        }
        return { ok: response.ok === true, status: typeof response.status === 'number' ? response.status : 0, body: body }
      })
    }

    function fetchJson(url, options) {
      if (typeof fetch !== 'function') return Promise.reject(new Error('fetch unavailable'))
      var opts = options || {}
      opts.credentials = 'same-origin'
      return fetch(url, opts).then(readJsonResponse)
    }

    function postJson(path, payload) {
      return fetchJson(API_BASE + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {}),
      })
    }

    function isAbsolutePath(value) {
      if (typeof value !== 'string' || value.length === 0) return false
      if (value.charAt(0) === '/') return true
      if (/^[A-Za-z]:[\\/]/.test(value)) return true
      return false
    }

    function stateUrl(cwd) {
      if (!isAbsolutePath(cwd)) return API_BASE + '/api/state'
      return API_BASE + '/api/state?cwd=' + encodeURIComponent(cwd)
    }

    /** Forward the optional cwd as a query so the JSON body stays exactly per contract. */
    function withCwdPath(path, cwd) {
      if (!isAbsolutePath(cwd)) return path
      return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'cwd=' + encodeURIComponent(cwd)
    }

    function initialOf(value) {
      var text = str(value).trim()
      return text.length > 0 ? text.charAt(0).toUpperCase() : '?'
    }

    function stripFrontmatter(text) {
      if (typeof text !== 'string') return ''
      var normalized = text.replace(/\r\n/g, '\n')
      if (normalized.indexOf('---') !== 0) return normalized
      var rest = normalized.slice(3)
      if (rest.indexOf('\n') !== 0) return normalized
      var end = rest.indexOf('\n---')
      if (end < 0) return normalized
      return rest.slice(end + 4).replace(/^\n/, '')
    }

    function conflictSeverity(conflict) {
      return conflict && conflict.severity === 'error' ? 'error' : 'warning'
    }

    function blockingConflicts(conflicts) {
      var out = []
      var list = arr(conflicts)
      for (var i = 0; i < list.length; i++) {
        if (list[i] && conflictSeverity(list[i]) === 'error') out.push(list[i])
      }
      return out
    }

    function forceableConflicts(conflicts) {
      var blocking = blockingConflicts(conflicts)
      if (blocking.length === 0) return false
      for (var i = 0; i < blocking.length; i++) {
        var code = blocking[i] && typeof blocking[i].code === 'string' ? blocking[i].code : ''
        if (!FORCEABLE_CONFLICTS[code]) return false
      }
      return true
    }

    function conflictKindKey(code) {
      if (code === 'duplicate-name') return 'conflict.kind.duplicate'
      if (code === 'alias-collision') return 'conflict.kind.alias'
      if (code === 'overlap') return 'conflict.kind.overlap'
      return ''
    }

    function conflictRoots(conflict) {
      var entries = arr(conflict && conflict.entries)
      var labels = []
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i]
        if (!entry || typeof entry !== 'object') continue
        var label = str(entry.rootLabel) || str(entry.rootId)
        if (label && labels.indexOf(label) < 0) labels.push(label)
      }
      return labels
    }

    function writableRoots(data) {
      var roots = arr(data && data.roots)
      var out = []
      for (var i = 0; i < roots.length; i++) {
        if (roots[i] && roots[i].writable === true && typeof roots[i].id === 'string') out.push(roots[i])
      }
      return out
    }

    function rootLabels(data) {
      var labels = {}
      var roots = arr(data && data.roots)
      for (var i = 0; i < roots.length; i++) {
        var root = roots[i]
        if (root && typeof root.id === 'string') labels[root.id] = str(root.label) || root.id
      }
      var skills = arr(data && data.skills)
      for (var j = 0; j < skills.length; j++) {
        var skill = skills[j]
        if (skill && typeof skill.rootId === 'string' && !hasOwn(labels, skill.rootId)) {
          labels[skill.rootId] = str(skill.rootLabel) || skill.rootId
        }
      }
      return labels
    }

    /**
     * Map the host registry probe onto a truthful status line. Three observed
     * states must stay distinct:
     *   checked && visible         -> success (agents can see it now)
     *   checked && !visible        -> warning (catalog has not caught up yet)
     *   !checked (with reason)     -> neutral info, never a failure: the host
     *                                 scope cannot observe the session catalog.
     */
    function registryOutcome(registry, tr) {
      if (!registry || typeof registry !== 'object' || registry.checked !== true) {
        return {
          text: tr('status.savedNoRegistry'),
          tone: 'info',
          detail: str(registry && registry.reason),
        }
      }
      if (registry.visible === true) return { text: tr('status.saved'), tone: 'ok' }
      return { text: tr('status.savedNotVisible'), tone: 'warn' }
    }

    /** Localized item count (the dictionaries only differ for the singular). */
    function countText(tr, count) {
      var key = count === 1 ? 'available.countOne' : 'available.count'
      return tr(key, { count: count })
    }

    function visibleConflicts(data) {
      return arr(data && data.conflicts)
    }

    function availableCount(data) {
      var total = 0
      var libraries = arr(data && data.libraries)
      for (var i = 0; i < libraries.length; i++) total += arr(libraries[i] && libraries[i].skills).length
      var installed = {}
      var skills = arr(data && data.skills)
      for (var j = 0; j < skills.length; j++) {
        if (skills[j] && typeof skills[j].name === 'string') installed[skills[j].name] = true
      }
      var catalog = data && data.catalog && typeof data.catalog === 'object' ? data.catalog : null
      // Plugin-provided catalog entries are shown even when the host-scope view
      // cannot cover the local roots; coverage only affects the save probe.
      var entries = arr(catalog && catalog.entries)
      for (var k = 0; k < entries.length; k++) {
        var entry = entries[k]
        if (entry && typeof entry.name === 'string' && !hasOwn(installed, entry.name)) total += 1
      }
      return total
    }

    // -----------------------------------------------------------------------
    // Styles — one <style> element, injected once via ctx.effect. Every
    // selector is scoped under `.dsm-root` (plus `@keyframes dsm-spin`), only
    // host theme tokens are used for colour, so light and dark both work.
    // -----------------------------------------------------------------------
    var CSS = [
      '.dsm-root{display:flex;flex-direction:column;gap:16px;width:100%;max-width:720px;margin:0 auto;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family,inherit);font-size:14px;line-height:22px}',
      '.dsm-root,.dsm-root *,.dsm-root *::before,.dsm-root *::after{box-sizing:border-box}',
      // Zero-specificity resets: :where() keeps the element selectors at (0,1,0)
      // so every class rule below (dsm-btn, dsm-seg-btn, dsm-input, ...) wins the
      // cascade regardless of property or source order.
      '.dsm-root :where(button){margin:0;padding:0;border:0;background:none;color:inherit;font:inherit;cursor:pointer}',
      '.dsm-root :where(input,select,textarea){margin:0;color:var(--dsw-alias-label-primary);font:inherit}',
      '.dsm-visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;padding:0;margin:-1px}',
      '.dsm-hero{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:10px 16px;padding:6px 0 2px}',
      '.dsm-hero-main{display:flex;flex-direction:column;gap:3px;min-width:0}',
      '.dsm-title{margin:0;font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.01em;color:var(--dsw-alias-label-primary)}',
      '.dsm-subtitle{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
      '.dsm-hero-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
      '.dsm-eyebrow{margin:0;font-size:11px;line-height:16px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}',
      '.dsm-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
      '.dsm-note--warn{color:var(--dsw-alias-state-warn-primary)}',
      '.dsm-note--error{color:var(--dsw-alias-state-error-primary)}',
      '.dsm-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border:1px solid transparent;border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px;white-space:nowrap;transition:background-color .15s ease,color .15s ease,border-color .15s ease,transform .1s ease}',
      '.dsm-btn:active:not(:disabled){transform:scale(.98)}',
      '.dsm-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.dsm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary-new-colorprimary-new-color);outline-offset:2px}',
      '.dsm-btn--accent{background:var(--dsw-alias-brand-primary-new-colorprimary-new-color);color:var(--dsw-alias-label-primary-inverted)}',
      '.dsm-btn--accent:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary-new-colorprimary-new-color) 88%,var(--dsw-alias-label-primary))}',
      '.dsm-btn--ghost{color:var(--dsw-alias-label-secondary)}',
      '.dsm-btn--ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsm-btn--outline{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}',
      '.dsm-btn--outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsm-btn--accent-outline{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary-new-colorprimary-new-color) 40%,var(--dsw-alias-border-l2));color:var(--dsw-alias-brand-primary-new-colorprimary-new-color)}',
      '.dsm-btn--accent-outline:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary-new-colorprimary-new-color) 10%,transparent)}',
      '.dsm-btn--danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,var(--dsw-alias-border-l2));color:var(--dsw-alias-state-error-primary)}',
      '.dsm-btn--danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}',
      '.dsm-btn--sm{height:26px;padding:0 9px;border-radius:var(--dsw-radius-sm);font-size:12px;line-height:18px}',
      '.dsm-btn--icon{width:32px;padding:0}',
      '.dsm-spin{animation:dsm-spin .9s linear infinite}',
      '@keyframes dsm-spin{to{transform:rotate(360deg)}}',
      '@media (prefers-reduced-motion:reduce){.dsm-spin{animation:none}.dsm-btn{transition:none}}',
      '.dsm-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}',
      '.dsm-stat{display:flex;flex-direction:column;gap:1px;min-width:0;padding:10px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2)}',
      '.dsm-stat-value{font-size:20px;line-height:26px;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
      '.dsm-stat-label{font-size:11px;line-height:16px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsm-stat--alert{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,var(--dsw-alias-border-l2))}',
      '.dsm-stat--alert .dsm-stat-value{color:var(--dsw-alias-state-error-primary)}',
      '.dsm-toolbar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px}',
      '.dsm-search{position:relative;display:flex;flex:1 1 220px;align-items:center;min-width:0}',
      '.dsm-search-icon{position:absolute;left:10px;display:flex;color:var(--dsw-alias-label-tertiary);pointer-events:none}',
      '.dsm-search .dsm-input{padding:0 34px}',
      '.dsm-input{width:100%;height:34px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;transition:border-color .15s ease}',
      '.dsm-input::placeholder,.dsm-textarea::placeholder{color:var(--dsw-alias-label-tertiary)}',
      '.dsm-input:focus,.dsm-select:focus,.dsm-textarea:focus{outline:2px solid var(--dsw-alias-brand-primary-new-colorprimary-new-color);outline-offset:-1px;border-color:transparent}',
      '.dsm-search-clear{position:absolute;right:5px;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary)}',
      '.dsm-search-clear:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsm-seg{display:inline-flex;flex-wrap:wrap;max-width:100%;gap:2px;padding:3px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsm-seg-btn{display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 14px;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:500;line-height:20px;transition:background-color .15s ease,color .15s ease}',
      '.dsm-seg-btn:hover{color:var(--dsw-alias-label-primary)}',
      '.dsm-seg-btn[aria-selected="true"],.dsm-seg-btn[aria-checked="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:0 0 0 1px var(--dsw-alias-border-l2)}',
      '.dsm-seg-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary-new-colorprimary-new-color);outline-offset:1px}',
      '.dsm-live{display:flex;align-items:flex-start;gap:8px;padding:9px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}',
      '.dsm-live--ok{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 35%,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-primary)}',
      '.dsm-live--warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-primary)}',
      '.dsm-live--error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,var(--dsw-alias-border-l2));color:var(--dsw-alias-state-error-primary)}',
      '.dsm-live-text{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}',
      '.dsm-live-close{display:inline-flex;flex:none;align-items:center;justify-content:center;width:20px;height:20px;margin:-2px -2px 0 0;border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-tertiary)}',
      '.dsm-live-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsm-live-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary-new-colorprimary-new-color);outline-offset:1px}',
      '.dsm-card{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
      '.dsm-card--pad{padding:18px}',
      '.dsm-loading{display:flex;align-items:center;gap:10px;padding:26px 18px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2)}',
      '.dsm-empty{display:flex;flex-direction:column;align-items:center;gap:5px;padding:34px 22px;border:1px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);text-align:center}',
      '.dsm-empty-icon{display:flex;margin-bottom:3px;color:var(--dsw-alias-label-tertiary)}',
      '.dsm-empty-title{margin:0;font-size:14px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dsm-empty-body{margin:0;max-width:430px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
      '.dsm-banner{display:flex;flex-direction:column;gap:8px;padding:14px 16px;border-radius:var(--dsw-radius-panel);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}',
      '.dsm-banner--error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,var(--dsw-alias-border-l2));background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 6%,var(--dsw-alias-bg-layer-2))}',
      '.dsm-banner--warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,var(--dsw-alias-border-l2));background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 7%,var(--dsw-alias-bg-layer-2))}',
      '.dsm-banner-head{display:flex;align-items:center;gap:8px}',
      '.dsm-banner-title{margin:0;font-size:14px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dsm-banner-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dsm-banner-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}',
      '.dsm-banner-item{display:flex;flex-direction:column;gap:2px}',
      '.dsm-banner-item + .dsm-banner-item{padding-top:8px;border-top:1px solid var(--dsw-alias-border-l2)}',
      '.dsm-banner-line{display:flex;flex-wrap:wrap;align-items:center;gap:6px}',
      '.dsm-banner-name{font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dsm-banner-msg{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
      '.dsm-kind{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:var(--dsw-radius-xs);font-size:10px;line-height:18px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}',
      '.dsm-kind--error{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}',
      '.dsm-kind--warn{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent)}',
      '.dsm-section{display:flex;flex-direction:column;gap:10px}',
      '.dsm-section-label{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:0 2px}',
      '.dsm-group{display:flex;flex-direction:column}',
      '.dsm-group-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:13px 16px 9px}',
      '.dsm-group-count{font-size:11px;line-height:16px;font-weight:500;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.dsm-row{border-top:1px solid var(--dsw-alias-border-l2);transition:background-color .15s ease}',
      '.dsm-group-head + .dsm-row,.dsm-group > .dsm-row:first-child,.dsm-lib-body > .dsm-row:first-child{border-top:0}',
      '.dsm-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsm-row:focus-within{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsm-row-main{display:flex;align-items:flex-start;gap:12px;padding:12px 16px}',
      '.dsm-mono{display:inline-flex;flex:none;align-items:center;justify-content:center;width:36px;height:36px;border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dsw-alias-brand-primary-new-colorprimary-new-color) 12%,transparent);color:var(--dsw-alias-brand-primary-new-colorprimary-new-color);font-size:15px;font-weight:600;line-height:1;text-transform:uppercase;user-select:none}',
      '.dsm-row-info{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-width:0}',
      '.dsm-row-titleline{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}',
      '.dsm-row-name{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dsm-row-desc{margin:0;overflow:hidden;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dsm-row-badges{display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin-top:2px}',
      '.dsm-badge{display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 7px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:18px;font-weight:500;white-space:nowrap}',
      '.dsm-badge--accent{background:color-mix(in srgb,var(--dsw-alias-brand-primary-new-colorprimary-new-color) 12%,transparent);color:var(--dsw-alias-brand-primary-new-colorprimary-new-color)}',
      '.dsm-badge--success{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);color:var(--dsw-alias-state-success-primary)}',
      '.dsm-badge--warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent);color:var(--dsw-alias-state-warn-primary)}',
      '.dsm-badge--error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary)}',
      '.dsm-badge--muted{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-tertiary)}',
      '.dsm-row-actions{display:flex;flex:none;align-items:center;gap:4px;margin-left:4px;padding-top:1px}',
      '.dsm-row-error{display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px;margin:0;padding:0 16px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}',
      '.dsm-confirm{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:0 16px 13px 64px}',
      '.dsm-confirm-text{flex:1 1 220px;margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}',
      '.dsm-confirm-actions{display:flex;flex-wrap:wrap;gap:6px}',
      '.dsm-lib-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:14px 16px 11px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
      '.dsm-lib-titles{display:flex;flex-direction:column;gap:1px;min-width:0}',
      '.dsm-lib-title{margin:0;font-size:14px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dsm-lib-path{margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
      '.dsm-lib-body{display:flex;flex-direction:column}',
      '.dsm-lib-note{padding:12px 16px}',
      '.dsm-editor{display:flex;flex-direction:column}',
      '.dsm-editor-head{display:flex;flex-direction:column;gap:3px;padding:18px 18px 0}',
      '.dsm-editor-title{margin:0;font-size:16px;line-height:24px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dsm-editor-body{display:flex;flex-direction:column;gap:14px;padding:16px 18px 18px}',
      '.dsm-field{display:flex;flex-direction:column;gap:5px;min-width:0}',
      '.dsm-label-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px}',
      '.dsm-label{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.dsm-counter{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.dsm-hint{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
      '.dsm-field-error{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary)}',
      '.dsm-textarea{display:block;width:100%;min-height:72px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;resize:vertical}',
      '.dsm-textarea--body{min-height:220px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:20px}',
      '.dsm-select{width:100%;height:34px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '.dsm-row2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px}',
      '.dsm-check{display:flex;align-items:flex-start;gap:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.dsm-check:focus-within .dsm-check-text{color:var(--dsw-alias-label-primary)}',
      '.dsm-check input{flex:none;width:15px;height:15px;margin:3px 0 0;accent-color:var(--dsw-alias-brand-primary-new-colorprimary-new-color)}',
      '.dsm-check input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary-new-colorprimary-new-color);outline-offset:2px}',
      '.dsm-check-text{display:flex;flex-direction:column;gap:1px;min-width:0}',
      '.dsm-errors{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent)}',
      '.dsm-errors--warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 35%,var(--dsw-alias-border-l2));background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent)}',
      '.dsm-error-item{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}',
      '.dsm-warning-item{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
      '.dsm-validation{display:flex;align-items:center;gap:8px;min-height:18px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dsm-validation--ok{color:var(--dsw-alias-state-success-primary)}',
      '.dsm-validation--error{color:var(--dsw-alias-state-error-primary)}',
      '.dsm-editor-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;padding-top:2px}',
      '.dsm-static{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
      '@media (max-width:640px){.dsm-row-main{flex-wrap:wrap}.dsm-row-actions{width:100%;margin-left:48px;padding-top:0}.dsm-confirm{padding-left:16px}.dsm-row2{grid-template-columns:minmax(0,1fr)}.dsm-hero-actions{width:100%}.dsm-hero-actions .dsm-btn--accent{flex:1 1 auto}}',
      '@media (max-width:430px){.dsm-stats{grid-template-columns:minmax(0,1fr)}.dsm-seg{width:100%}.dsm-seg-btn{flex:1 1 0}}',
    ].join('\n')

    function ensureStyles() {
      if (typeof document === 'undefined') return function () {}
      var existing = document.getElementById(STYLE_ID)
      if (existing) return function () {}
      var style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      var parent = document.head || document.documentElement
      if (!parent) return function () {}
      parent.appendChild(style)
      return function () {
        if (style.parentNode) style.parentNode.removeChild(style)
      }
    }

    // -----------------------------------------------------------------------
    // Icons — inline strokes in currentColor, always aria-hidden.
    // -----------------------------------------------------------------------
    function iconProps(size) {
      return {
        viewBox: '0 0 24 24',
        width: size || 16,
        height: size || 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }
    }

    function IconPlus() {
      return h('svg', iconProps(16), h('path', { d: 'M12 5v14' }), h('path', { d: 'M5 12h14' }))
    }

    function IconRefresh() {
      return h(
        'svg',
        iconProps(16),
        h('path', { d: 'M21 12a9 9 0 1 1-2.64-6.36' }),
        h('path', { d: 'M21 3v6h-6' }),
      )
    }

    function IconSearch() {
      return h('svg', iconProps(15), h('circle', { cx: 11, cy: 11, r: 7 }), h('path', { d: 'm20 20-3.5-3.5' }))
    }

    function IconEdit() {
      return h(
        'svg',
        iconProps(14),
        h('path', { d: 'M12 20h9' }),
        h('path', { d: 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z' }),
      )
    }

    function IconTrash() {
      return h(
        'svg',
        iconProps(14),
        h('path', { d: 'M3 6h18' }),
        h('path', { d: 'M8 6V4h8v2' }),
        h('path', { d: 'M19 6l-1 14H6L5 6' }),
        h('path', { d: 'M10 11v6' }),
        h('path', { d: 'M14 11v6' }),
      )
    }

    function IconAlert() {
      return h(
        'svg',
        iconProps(16),
        h('path', { d: 'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z' }),
        h('path', { d: 'M12 9v4' }),
        h('path', { d: 'M12 17h.01' }),
      )
    }

    function IconCheck() {
      return h('svg', iconProps(15), h('path', { d: 'M20 6 9 17l-5-5' }))
    }

    function IconX() {
      return h('svg', iconProps(14), h('path', { d: 'M18 6 6 18' }), h('path', { d: 'm6 6 12 12' }))
    }

    function IconBook() {
      return h(
        'svg',
        iconProps(22),
        h('path', { d: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20' }),
        h('path', { d: 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z' }),
      )
    }

    function IconSpark() {
      return h(
        'svg',
        iconProps(22),
        h('path', { d: 'M12 3v3' }),
        h('path', { d: 'M12 18v3' }),
        h('path', { d: 'M3 12h3' }),
        h('path', { d: 'M18 12h3' }),
        h('path', { d: 'm5.6 5.6 2.1 2.1' }),
        h('path', { d: 'm16.3 16.3 2.1 2.1' }),
        h('path', { d: 'm18.4 5.6-2.1 2.1' }),
        h('path', { d: 'm7.7 16.3-2.1 2.1' }),
      )
    }

    function Spinner() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', 'aria-hidden': 'true', focusable: 'false', className: 'dsm-spin' },
        h('circle', { cx: 12, cy: 12, r: 9, stroke: 'currentColor', strokeWidth: 2.5, opacity: '0.25' }),
        h('path', { d: 'M21 12a9 9 0 0 0-9-9', stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round' }),
      )
    }

    // -----------------------------------------------------------------------
    // Shared presentational pieces
    // -----------------------------------------------------------------------

    /** A small pill button used for row actions. */
    function PillButton(props) {
      var classes = 'dsm-btn dsm-btn--sm'
      if (props.variant) classes += ' dsm-btn--' + props.variant
      return h(
        'button',
        {
          type: 'button',
          className: classes,
          onClick: props.onClick,
          disabled: props.disabled === true,
          title: props.title,
          'aria-label': props.ariaLabel,
        },
        props.icon || null,
        props.children,
      )
    }

    /** Rounded monogram tile (decorative: the name is rendered next to it). */
    function Monogram(props) {
      return h('span', { className: 'dsm-mono', 'aria-hidden': 'true' }, initialOf(props.name))
    }

    function Badge(props) {
      var classes = 'dsm-badge' + (props.tone ? ' dsm-badge--' + props.tone : '')
      return h('span', { className: classes, title: props.title }, props.children)
    }

    function KindTag(props) {
      var classes = 'dsm-kind' + (props.tone ? ' dsm-kind--' + props.tone : '')
      return h('span', { className: classes }, props.children)
    }

    function Stats(props) {
      var tr = props.tr
      var data = props.data
      var conflicts = data && data.stats && typeof data.stats.conflicts === 'number' ? data.stats.conflicts : visibleConflicts(data).length
      var installed = data && data.stats && typeof data.stats.skills === 'number' ? data.stats.skills : arr(data && data.skills).length
      var available = availableCount(data)
      var items = [
        { key: 'installed', label: tr('stats.installed'), value: installed },
        { key: 'available', label: tr('stats.available'), value: available },
        { key: 'conflicts', label: tr('stats.conflicts'), value: conflicts, alert: conflicts > 0 },
      ]
      return h(
        'div',
        { className: 'dsm-stats', role: 'group', 'aria-label': tr('aria.summary'), 'data-dsm': 'stats' },
        items.map(function (item) {
          return h(
            'div',
            { key: item.key, className: 'dsm-stat' + (item.alert ? ' dsm-stat--alert' : '') },
            h('span', { className: 'dsm-stat-value' }, String(item.value)),
            h('span', { className: 'dsm-stat-label' }, item.label),
          )
        }),
      )
    }

    function Tabs(props) {
      var tr = props.tr
      var options = [
        { value: 'installed', label: tr('tab.installed') },
        { value: 'available', label: tr('tab.available') },
      ]
      var refs = React.useRef([])
      function onKeyDown(event, index) {
        var dir = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
        if (dir === 0) return
        event.preventDefault()
        var next = (index + dir + options.length) % options.length
        props.onChange(options[next].value)
        var target = refs.current[next]
        if (target && typeof target.focus === 'function') target.focus()
      }
      return h(
        'div',
        { className: 'dsm-seg', role: 'tablist', 'aria-label': tr('aria.views'), 'data-dsm': 'tabs' },
        options.map(function (option, index) {
          var active = props.value === option.value
          return h(
            'button',
            {
              key: option.value,
              ref: function (element) {
                refs.current[index] = element
              },
              type: 'button',
              role: 'tab',
              id: 'dsm-tab-' + option.value,
              'aria-selected': active ? 'true' : 'false',
              'aria-controls': 'dsm-panel-' + option.value,
              tabIndex: active ? 0 : -1,
              className: 'dsm-seg-btn' + (active ? ' is-active' : ''),
              onClick: function () {
                props.onChange(option.value)
              },
              onKeyDown: function (event) {
                onKeyDown(event, index)
              },
            },
            option.label,
          )
        }),
      )
    }

    function ChoiceSeg(props) {
      var options = props.options
      var refs = React.useRef([])
      function onKeyDown(event, index) {
        var dir = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
        if (dir === 0) return
        event.preventDefault()
        var next = (index + dir + options.length) % options.length
        props.onChange(options[next].value)
        var target = refs.current[next]
        if (target && typeof target.focus === 'function') target.focus()
      }
      return h(
        'div',
        { className: 'dsm-seg', role: 'radiogroup', 'aria-label': props.label },
        options.map(function (option, index) {
          var active = props.value === option.value
          return h(
            'button',
            {
              key: option.value,
              ref: function (element) {
                refs.current[index] = element
              },
              type: 'button',
              role: 'radio',
              'aria-checked': active ? 'true' : 'false',
              tabIndex: active ? 0 : -1,
              className: 'dsm-seg-btn' + (active ? ' is-active' : ''),
              onClick: function () {
                props.onChange(option.value)
              },
              onKeyDown: function (event) {
                onKeyDown(event, index)
              },
            },
            option.label,
          )
        }),
      )
    }

    function LiveMessage(props) {
      var tr = props.tr
      if (!props.message) return null
      var tone = props.message.tone || 'info'
      return h(
        'div',
        {
          className: 'dsm-live' + (tone === 'ok' ? ' dsm-live--ok' : tone === 'warn' ? ' dsm-live--warn' : tone === 'error' ? ' dsm-live--error' : ''),
          role: props.message.role || 'status',
          'aria-live': props.message.role === 'alert' ? 'assertive' : 'polite',
          'data-dsm': 'live',
        },
        h('span', { className: 'dsm-live-text', title: props.message.detail || undefined }, props.message.text),
        h(
          'button',
          {
            type: 'button',
            className: 'dsm-live-close',
            onClick: props.onDismiss,
            'aria-label': tr('aria.dismiss'),
            title: tr('action.dismiss'),
          },
          h(IconX),
        ),
      )
    }

    function ConflictBanner(props) {
      var tr = props.tr
      var list = arr(props.conflicts)
      if (list.length === 0) return null
      var errors = []
      var warnings = []
      for (var i = 0; i < list.length; i++) {
        if (conflictSeverity(list[i]) === 'error') errors.push(list[i])
        else warnings.push(list[i])
      }
      var tone = errors.length > 0 ? 'error' : 'warn'
      return h(
        'div',
        { className: 'dsm-banner ' + (tone === 'error' ? 'dsm-banner--error' : 'dsm-banner--warn'), role: 'alert', 'data-dsm': 'conflict-banner' },
        h(
          'div',
          { className: 'dsm-banner-head' },
          errors.length > 0 ? h(IconAlert) : h(IconSpark),
          h('h3', { className: 'dsm-banner-title' }, tr('conflict.title')),
        ),
        h('p', { className: 'dsm-banner-hint' }, tr('conflict.hint')),
        h(
          'ul',
          { className: 'dsm-banner-list' },
          list.map(function (conflict, index) {
            var severity = conflictSeverity(conflict)
            var kindKey = conflictKindKey(conflict && conflict.code)
            var roots = conflictRoots(conflict)
            var shared = arr(conflict && conflict.sharedWords)
            return h(
              'li',
              { key: (conflict && conflict.code ? conflict.code : 'conflict') + ':' + index, className: 'dsm-banner-item' },
              h(
                'div',
                { className: 'dsm-banner-line' },
                h(KindTag, { tone: severity === 'error' ? 'error' : 'warn' }, severity === 'error' ? tr('conflict.error') : tr('conflict.warning')),
                h('span', { className: 'dsm-banner-name' }, str(conflict && conflict.name) || '—'),
                kindKey ? h('span', { className: 'dsm-badge dsm-badge--muted' }, tr(kindKey)) : null,
              ),
              h('p', { className: 'dsm-banner-msg' }, str(conflict && conflict.message) || ''),
              roots.length > 0 ? h('p', { className: 'dsm-banner-msg' }, tr('conflict.entries', { roots: roots.join(', ') })) : null,
              shared.length > 0 ? h('p', { className: 'dsm-banner-msg' }, tr('conflict.sharedWords', { words: shared.join(', ') })) : null,
            )
          }),
        ),
      )
    }

    function EmptyState(props) {
      return h(
        'div',
        { className: 'dsm-empty', role: 'status' },
        h('span', { className: 'dsm-empty-icon' }, props.icon || h(IconBook)),
        h('p', { className: 'dsm-empty-title' }, props.title),
        props.body ? h('p', { className: 'dsm-empty-body' }, props.body) : null,
      )
    }

    // -----------------------------------------------------------------------
    // Installed tab
    // -----------------------------------------------------------------------

    function groupSkills(data, query) {
      var q = str(query).trim().toLowerCase()
      var skills = arr(data && data.skills)
      var filtered = []
      for (var i = 0; i < skills.length; i++) {
        var skill = skills[i]
        if (!skill || typeof skill !== 'object') continue
        if (q) {
          var haystack = (str(skill.name) + ' ' + str(skill.description)).toLowerCase()
          if (haystack.indexOf(q) < 0) continue
        }
        filtered.push(skill)
      }
      var roots = arr(data && data.roots)
      var order = {}
      var labels = rootLabels(data)
      for (var r = 0; r < roots.length; r++) {
        if (roots[r] && typeof roots[r].id === 'string' && !hasOwn(order, roots[r].id)) order[roots[r].id] = r
      }
      var byRoot = {}
      var rootIds = []
      for (var j = 0; j < filtered.length; j++) {
        var id = typeof filtered[j].rootId === 'string' && filtered[j].rootId ? filtered[j].rootId : 'unknown'
        if (!hasOwn(byRoot, id)) {
          byRoot[id] = []
          rootIds.push(id)
        }
        byRoot[id].push(filtered[j])
      }
      rootIds.sort(function (a, b) {
        var oa = hasOwn(order, a) ? order[a] : 100000
        var ob = hasOwn(order, b) ? order[b] : 100000
        if (oa !== ob) return oa - ob
        return a < b ? -1 : a > b ? 1 : 0
      })
      var groups = []
      for (var k = 0; k < rootIds.length; k++) {
        var rootId = rootIds[k]
        var list = byRoot[rootId]
        list.sort(function (a, b) {
          var an = str(a && a.name)
          var bn = str(b && b.name)
          return an < bn ? -1 : an > bn ? 1 : 0
        })
        groups.push({ rootId: rootId, label: labels[rootId] || rootId, skills: list })
      }
      return { groups: groups, matchCount: filtered.length, total: skills.length }
    }

    function SkillRow(props) {
      var tr = props.tr
      var skill = props.skill || {}
      var writable = skill.writable === true
      var confirming = props.confirming === true
      var busy = props.busy === true
      var confirmRef = React.useRef(null)
      React.useEffect(
        function () {
          if (confirming && confirmRef.current && typeof confirmRef.current.focus === 'function') confirmRef.current.focus()
        },
        [confirming],
      )
      var badges = []
      if (skill.kind === 'flat') badges.push({ key: 'kind', text: tr('badge.flat'), tone: 'accent' })
      else if (skill.kind === 'bundle') badges.push({ key: 'kind', text: tr('badge.bundle'), tone: 'accent' })
      if (skill.modelInvocable === true) badges.push({ key: 'model', text: tr('badge.model') })
      if (skill.userInvocable === true) badges.push({ key: 'user', text: tr('badge.user') })
      if (skill.modelInvocable !== true && skill.userInvocable !== true) badges.push({ key: 'hidden', text: tr('badge.hidden'), tone: 'muted' })
      if (typeof skill.rank === 'number') badges.push({ key: 'rank', text: tr('badge.rank', { rank: skill.rank }), tone: 'muted' })
      badges.push({ key: 'root', text: str(skill.rootLabel) || str(skill.rootId) || '—', tone: 'muted' })
      var hasConflict = props.conflict === true
      var firstError = ''
      var skillErrors = arr(skill.errors)
      if (skill.valid === false && skillErrors.length > 0 && skillErrors[0] && typeof skillErrors[0].message === 'string') {
        firstError = skillErrors[0].message
      }
      return h(
        'div',
        { className: 'dsm-row', 'data-dsm': 'skill-row', 'data-skill': str(skill.name) },
        h(
          'div',
          { className: 'dsm-row-main' },
          h(Monogram, { name: skill.name }),
          h(
            'div',
            { className: 'dsm-row-info' },
            h(
              'div',
              { className: 'dsm-row-titleline' },
              h('span', { className: 'dsm-row-name', title: str(skill.relPath) }, str(skill.name) || '—'),
              skill.valid === false ? h(KindTag, { tone: 'error' }, tr('badge.invalid')) : null,
              hasConflict ? h(KindTag, { tone: 'error' }, tr('badge.conflict')) : null,
            ),
            h('p', { className: 'dsm-row-desc', title: str(skill.description) }, str(skill.description) || tr('row.noDescription')),
            h(
              'div',
              { className: 'dsm-row-badges' },
              badges.map(function (badge) {
                return h(Badge, { key: badge.key, tone: badge.tone }, badge.text)
              }),
            ),
            firstError ? h('p', { className: 'dsm-field-error' }, firstError) : null,
          ),
          h(
            'div',
            { className: 'dsm-row-actions' },
            writable
              ? [
                  h(PillButton, {
                    key: 'edit',
                    variant: 'ghost',
                    icon: h(IconEdit),
                    onClick: function () {
                      props.onEdit(skill)
                    },
                    disabled: busy,
                    ariaLabel: tr('aria.edit', { name: str(skill.name) }),
                  }, tr('action.edit')),
                  h(PillButton, {
                    key: 'delete',
                    variant: 'danger',
                    icon: h(IconTrash),
                    onClick: function () {
                      props.onDeleteStart(skill)
                    },
                    disabled: busy,
                    ariaLabel: tr('aria.delete', { name: str(skill.name) }),
                  }, tr('action.delete')),
                ]
              : h('span', { className: 'dsm-badge dsm-badge--muted' }, tr('badge.readonly')),
          ),
        ),
        confirming
          ? h(
              'div',
              { className: 'dsm-confirm', role: 'group', 'aria-label': tr('aria.deleteConfirmActions', { name: str(skill.name) }) },
              h('p', { className: 'dsm-confirm-text' }, tr('delete.confirm', { name: str(skill.name) })),
              h(
                'div',
                { className: 'dsm-confirm-actions' },
                h(
                  'button',
                  {
                    ref: confirmRef,
                    type: 'button',
                    className: 'dsm-btn dsm-btn--sm dsm-btn--danger',
                    onClick: function () {
                      props.onDeleteConfirm(skill)
                    },
                    disabled: busy,
                    'aria-label': tr('aria.confirmDelete', { name: str(skill.name) }),
                  },
                  busy ? h(Spinner) : null,
                  busy ? tr('action.deleting') : tr('action.delete'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsm-btn dsm-btn--sm dsm-btn--ghost',
                    onClick: function () {
                      props.onDeleteCancel()
                    },
                    disabled: busy,
                  },
                  tr('action.cancel'),
                ),
              ),
            )
          : null,
        props.deleteError && confirming
          ? h('p', { className: 'dsm-row-error', role: 'alert' }, props.deleteError)
          : null,
      )
    }

    function InstalledTab(props) {
      var tr = props.tr
      var data = props.data
      var result = groupSkills(data, props.query)
      var conflicts = visibleConflicts(data)
      var children = []
      if (result.total === 0) {
        children.push(h(EmptyState, { key: 'empty', title: tr('empty.installed'), body: tr('empty.installedHint') }))
      } else if (result.matchCount === 0) {
        children.push(h(EmptyState, { key: 'empty', title: tr('search.empty'), body: tr('search.emptyHint'), icon: h(IconSearch) }))
      } else {
        children.push(h(ConflictBanner, { key: 'banner', tr: tr, conflicts: conflicts }))
        var conflictNames = {}
        for (var c = 0; c < conflicts.length; c++) {
          if (conflicts[c] && conflictSeverity(conflicts[c]) === 'error' && typeof conflicts[c].name === 'string') conflictNames[conflicts[c].name] = true
        }
        children.push(
          result.groups.map(function (group) {
            return h(
              'section',
              { key: group.rootId, className: 'dsm-card', 'data-dsm': 'root-group' },
              h(
                'div',
                { className: 'dsm-group-head' },
                h('h3', { className: 'dsm-eyebrow' }, group.label),
                h('span', { className: 'dsm-group-count' }, countText(tr, group.skills.length)),
              ),
              h(
                'div',
                { className: 'dsm-group' },
                group.skills.map(function (skill) {
                  var key = str(skill.id) || (str(skill.rootId) + ':' + str(skill.relPath))
                  return h(SkillRow, {
                    key: key,
                    tr: tr,
                    skill: skill,
                    conflict: hasOwn(conflictNames, str(skill.name)),
                    confirming: props.confirmDelete === key,
                    busy: props.busyKey !== null,
                    deleteError: props.rowErrors[key] || '',
                    onEdit: props.onEdit,
                    onDeleteStart: props.onDeleteStart,
                    onDeleteCancel: props.onDeleteCancel,
                    onDeleteConfirm: props.onDeleteConfirm,
                  })
                }),
              ),
            )
          }),
        )
      }
      // The tabpanel role must survive loading-independent list states: the
      // Installed|Available tab stays mounted and its aria-controls target has
      // to exist even while the filtered list is empty (for example right after
      // deleting the last matching skill).
      return h(
        'div',
        { className: 'dsm-section', role: 'tabpanel', id: 'dsm-panel-installed', 'aria-labelledby': 'dsm-tab-installed' },
        children,
      )
    }

    // -----------------------------------------------------------------------
    // Available tab
    // -----------------------------------------------------------------------

    function rowMatches(item, query) {
      var q = str(query).trim().toLowerCase()
      if (!q) return true
      return (str(item && item.name) + ' ' + str(item && item.description)).toLowerCase().indexOf(q) >= 0
    }

    function LibraryRow(props) {
      var tr = props.tr
      var item = props.item || {}
      var status = str(item.status)
      var installed = item.installed && typeof item.installed === 'object' ? item.installed : null
      var installedLabel = ''
      if (installed) {
        var label = str(installed.rootLabel) || str(props.rootLabels[installed.rootId]) || ''
        if (label) installedLabel = label
      }
      var busy = props.busy === true
      var disabled = busy || props.anyBusy === true
      var confirming = props.confirming === true
      var confirmRef = React.useRef(null)
      React.useEffect(
        function () {
          if (confirming && confirmRef.current && typeof confirmRef.current.focus === 'function') confirmRef.current.focus()
        },
        [confirming],
      )
      var badges = []
      if (item.kind === 'flat') badges.push({ key: 'kind', text: tr('badge.flat'), tone: 'accent' })
      else if (item.kind === 'bundle') badges.push({ key: 'kind', text: tr('badge.bundle'), tone: 'accent' })
      if (installedLabel) badges.push({ key: 'installedIn', text: tr('available.installedIn', { root: installedLabel }) })
      var action = null
      if (status === 'installed') action = h('span', { className: 'dsm-badge dsm-badge--success' }, tr('badge.installed'))
      else if (status === 'update') {
        action = confirming
          ? null
          : h(
              'button',
              {
                type: 'button',
                className: 'dsm-btn dsm-btn--sm dsm-btn--accent-outline',
                onClick: function () {
                  props.onUpdateStart(item)
                },
                disabled: disabled,
                'aria-label': tr('aria.update', { name: str(item.name) }),
              },
              h(IconRefresh),
              tr('action.update'),
            )
      } else if (status === 'available') {
        action = h(
          'button',
          {
            type: 'button',
            className: 'dsm-btn dsm-btn--sm dsm-btn--accent-outline',
            onClick: function () {
              props.onInstall(item, {})
            },
            disabled: disabled,
            'aria-label': tr('aria.install', { name: str(item.name) }),
          },
          busy ? h(Spinner) : null,
          busy ? tr('action.installing') : tr('action.install'),
        )
      } else if (status === 'conflict') {
        action = h(
          'button',
          {
            type: 'button',
            className: 'dsm-btn dsm-btn--sm dsm-btn--outline',
            onClick: function () {
              props.onInstall(item, { force: true })
            },
            disabled: disabled,
            'aria-label': tr('aria.installAnyway', { name: str(item.name) }),
          },
          busy ? h(Spinner) : null,
          tr('action.installAnyway'),
        )
      } else if (status) {
        action = h('span', { className: 'dsm-badge dsm-badge--muted' }, status)
      }
      var rowError = str(props.rowError)
      var canForce = props.force === true
      return h(
        'div',
        { className: 'dsm-row', 'data-dsm': 'library-row', 'data-skill': str(item.name) },
        h(
          'div',
          { className: 'dsm-row-main' },
          h(Monogram, { name: item.name }),
          h(
            'div',
            { className: 'dsm-row-info' },
            h(
              'div',
              { className: 'dsm-row-titleline' },
              h('span', { className: 'dsm-row-name' }, str(item.name) || '—'),
              status === 'installed' ? h(KindTag, null, tr('badge.installed')) : null,
              status === 'update' ? h(KindTag, { tone: 'warn' }, tr('badge.update')) : null,
            ),
            h('p', { className: 'dsm-row-desc', title: str(item.description) }, str(item.description) || tr('row.noDescription')),
            h(
              'div',
              { className: 'dsm-row-badges' },
              badges.map(function (badge) {
                return h(Badge, { key: badge.key, tone: badge.tone }, badge.text)
              }),
            ),
            status === 'conflict' ? h('p', { className: 'dsm-note dsm-note--warn' }, tr('available.installConflict')) : null,
          ),
          h('div', { className: 'dsm-row-actions' }, action),
        ),
        confirming
          ? h(
              'div',
              { className: 'dsm-confirm', role: 'group', 'aria-label': tr('aria.updateConfirmActions', { name: str(item.name) }) },
              h('p', { className: 'dsm-confirm-text' }, tr('available.confirmUpdate')),
              h(
                'div',
                { className: 'dsm-confirm-actions' },
                h(
                  'button',
                  {
                    ref: confirmRef,
                    type: 'button',
                    className: 'dsm-btn dsm-btn--sm dsm-btn--accent',
                    onClick: function () {
                      props.onUpdateConfirm(item)
                    },
                    disabled: disabled,
                  },
                  busy ? h(Spinner) : null,
                  busy ? tr('action.replacing') : tr('action.replace'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsm-btn dsm-btn--sm dsm-btn--ghost',
                    onClick: function () {
                      props.onUpdateCancel()
                    },
                    disabled: disabled,
                  },
                  tr('action.cancel'),
                ),
              ),
            )
          : null,
        rowError
          ? h(
              'p',
              { className: 'dsm-row-error', role: 'alert' },
              rowError,
              canForce
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsm-btn dsm-btn--sm dsm-btn--outline',
                      onClick: function () {
                        props.onInstall(item, { force: true })
                      },
                      disabled: disabled,
                    },
                    tr('action.installAnyway'),
                  )
                : null,
            )
          : null,
      )
    }

    function LibraryCard(props) {
      var tr = props.tr
      var library = props.library || {}
      var skills = arr(library.skills)
      var q = str(props.query).trim()
      var visible = []
      for (var i = 0; i < skills.length; i++) if (rowMatches(skills[i], q)) visible.push(skills[i])
      if (q && visible.length === 0) return null
      var missing = library.exists === false
      var label = str(library.label) || str(library.id) || ''
      return h(
        'section',
        { className: 'dsm-card', 'aria-label': tr('aria.library', { label: label }), 'data-dsm': 'library-card', 'data-library': str(library.id) },
        h(
          'div',
          { className: 'dsm-lib-head' },
          h(
            'div',
            { className: 'dsm-lib-titles' },
            h('h3', { className: 'dsm-lib-title' }, label || '—'),
            h('p', { className: 'dsm-lib-path', title: str(library.path) }, str(library.path) || ''),
          ),
          missing ? h('span', { className: 'dsm-badge dsm-badge--warn' }, tr('available.libraryMissingBadge')) : h('span', { className: 'dsm-badge dsm-badge--muted' }, countText(tr, skills.length)),
        ),
        missing
          ? h('div', { className: 'dsm-lib-note' }, h('p', { className: 'dsm-note' }, tr('available.libraryMissing', { path: str(library.path) })))
          : visible.length === 0
            ? h('div', { className: 'dsm-lib-note' }, h('p', { className: 'dsm-note' }, tr('available.libraryEmpty')))
            : h(
                'div',
                { className: 'dsm-lib-body' },
                visible.map(function (item) {
                  var key = str(item.relPath) || str(item.name)
                  var rowKey = 'install:' + str(library.id) + ':' + key
                  return h(LibraryRow, {
                    key: key,
                    tr: tr,
                    item: item,
                    rootLabels: props.rootLabels,
                    busy: props.busyKey === rowKey,
                    anyBusy: props.busyKey !== null,
                    confirming: props.confirmUpdate === rowKey,
                    rowError: props.rowErrors[rowKey] || '',
                    force: props.rowForce[rowKey] === true,
                    onInstall: function (target, options) {
                      props.onInstall(library, target, options)
                    },
                    onUpdateStart: function (target) {
                      props.onUpdateStart(library, target, rowKey)
                    },
                    onUpdateConfirm: function (target) {
                      props.onUpdateConfirm(library, target, rowKey)
                    },
                    onUpdateCancel: props.onUpdateCancel,
                  })
                }),
              ),
      )
    }

    function CatalogGroup(props) {
      var tr = props.tr
      var entries = arr(props.entries)
      var hostScope = props.hostScope === true
      var hostScopeNote = hostScope
        ? h('div', { className: 'dsm-lib-note' }, h('p', { className: 'dsm-note' }, tr('available.pluginsHostScope')))
        : null
      if (hostScope && entries.length === 0) {
        return h(
          'section',
          { className: 'dsm-card', 'data-dsm': 'catalog-group' },
          h(
            'div',
            { className: 'dsm-lib-head' },
            h('div', { className: 'dsm-lib-titles' }, h('h3', { className: 'dsm-lib-title' }, tr('available.plugins')), h('p', { className: 'dsm-lib-path' }, tr('available.pluginsHint'))),
          ),
          hostScopeNote,
        )
      }
      if (entries.length === 0) {
        return h(
          'section',
          { className: 'dsm-card', 'data-dsm': 'catalog-group' },
          h(
            'div',
            { className: 'dsm-lib-head' },
            h('div', { className: 'dsm-lib-titles' }, h('h3', { className: 'dsm-lib-title' }, tr('available.plugins')), h('p', { className: 'dsm-lib-path' }, tr('available.pluginsHint'))),
          ),
          h('div', { className: 'dsm-lib-note' }, h('p', { className: 'dsm-note' }, tr('available.pluginsEmpty'))),
        )
      }
      return h(
        'section',
        { className: 'dsm-card', 'data-dsm': 'catalog-group' },
        h(
          'div',
          { className: 'dsm-lib-head' },
          h('div', { className: 'dsm-lib-titles' }, h('h3', { className: 'dsm-lib-title' }, tr('available.plugins')), h('p', { className: 'dsm-lib-path' }, tr('available.pluginsHint'))),
          h('span', { className: 'dsm-badge dsm-badge--muted' }, countText(tr, entries.length)),
        ),
        h(
          'div',
          { className: 'dsm-lib-body' },
          entries.map(function (entry, index) {
            var provider = str(entry && entry.provider)
            return h(
              'div',
              { key: str(entry && entry.name) || String(index), className: 'dsm-row', 'data-dsm': 'catalog-row' },
              h(
                'div',
                { className: 'dsm-row-main' },
                h(Monogram, { name: entry && entry.name }),
                h(
                  'div',
                  { className: 'dsm-row-info' },
                  h('div', { className: 'dsm-row-titleline' }, h('span', { className: 'dsm-row-name' }, str(entry && entry.name) || '—')),
                  h('p', { className: 'dsm-row-desc', title: str(entry && entry.description) }, str(entry && entry.description) || tr('row.noDescription')),
                  h(
                    'div',
                    { className: 'dsm-row-badges' },
                    provider ? h(Badge, { tone: 'muted' }, tr('catalog.provider', { provider: provider })) : null,
                  ),
                ),
                h('div', { className: 'dsm-row-actions' }, h('span', { className: 'dsm-badge dsm-badge--muted' }, tr('badge.readonly'))),
              ),
            )
          }),
        ),
        hostScopeNote,
      )
    }

    function AvailableTab(props) {
      var tr = props.tr
      var data = props.data
      var query = props.query
      var libraries = arr(data && data.libraries)
      var catalog = data && data.catalog && typeof data.catalog === 'object' ? data.catalog : { available: false, error: null, entries: [] }
      var installed = {}
      var skills = arr(data && data.skills)
      for (var i = 0; i < skills.length; i++) {
        if (skills[i] && typeof skills[i].name === 'string') installed[skills[i].name] = true
      }
      var catalogCoversLocal = catalog.coversLocalRoots !== false
      var catalogEntries = []
      var entries = arr(catalog.entries)
      for (var j = 0; j < entries.length; j++) {
        var entry = entries[j]
        if (!entry || typeof entry.name !== 'string') continue
        if (hasOwn(installed, entry.name)) continue
        if (!rowMatches(entry, query)) continue
        catalogEntries.push(entry)
      }
      var q = str(query).trim()
      var libraryCards = libraries.filter(function (library) {
        if (!q) return true
        var list = arr(library && library.skills)
        for (var k = 0; k < list.length; k++) if (rowMatches(list[k], q)) return true
        return false
      })
      var hasLibraries = libraryCards.length > 0
      var hasCatalog = catalog.available === true && catalogEntries.length > 0
      var catalogNode = null
      if (catalog.available !== true) {
        catalogNode = h('p', { className: 'dsm-note' }, tr('available.catalogUnavailable'))
      } else if (!q || catalogEntries.length > 0 || entries.length === 0) {
        // Plugin-provided skills stay visible even when this host-scope view
        // cannot prove coverage of the local roots; the note below explains
        // that only the session catalog can confirm local writes.
        catalogNode = h(CatalogGroup, { key: 'catalog', tr: tr, entries: catalogEntries, hostScope: !catalogCoversLocal })
      }
      function panel(children) {
        return h(
          'div',
          { className: 'dsm-section', role: 'tabpanel', id: 'dsm-panel-available', 'aria-labelledby': 'dsm-tab-available' },
          children,
        )
      }
      if (!hasLibraries && !hasCatalog) {
        if (catalog.available === true && !catalogCoversLocal) {
          // The plugin catalog exists but the host scope cannot see the local
          // roots: show the explanatory group instead of a misleading empty state.
          return panel(catalogNode)
        }
        if (q && (libraries.length > 0 || entries.length > 0)) {
          return panel(h(EmptyState, { title: tr('search.empty'), body: tr('search.emptyHint'), icon: h(IconSearch) }))
        }
        return panel(h(
          EmptyState,
          {
            title: tr('available.emptyTitle'),
            body: tr('available.emptyBody') + (catalog.available === false ? ' ' + tr('available.catalogUnavailable') : ''),
            icon: h(IconSpark),
          },
        ))
      }
      var body = []
      if (hasLibraries) {
        body.push(
          h(
            React.Fragment,
            { key: 'libraries' },
            h(
              'div',
              { className: 'dsm-section-label' },
              h('h3', { className: 'dsm-eyebrow' }, tr('available.libraries')),
              h('span', { className: 'dsm-note' }, tr('available.librariesHint')),
            ),
            libraryCards.map(function (library) {
              return h(LibraryCard, {
                key: str(library && library.id),
                tr: tr,
                library: library,
                query: query,
                rootLabels: rootLabels(data),
                busyKey: props.busyKey,
                confirmUpdate: props.confirmUpdate,
                rowErrors: props.rowErrors,
                rowForce: props.rowForce,
                onInstall: props.onInstall,
                onUpdateStart: props.onUpdateStart,
                onUpdateConfirm: props.onUpdateConfirm,
                onUpdateCancel: props.onUpdateCancel,
              })
            }),
          ),
        )
      }
      if (catalogNode !== null) body.push(h('div', { key: 'catalog-slot' }, catalogNode))
      return panel(body)
    }

    // -----------------------------------------------------------------------
    // Add/Edit editor
    // -----------------------------------------------------------------------

    function copyDraft(source) {
      var draft = source && typeof source === 'object' ? source : {}
      return {
        name: str(draft.name),
        description: str(draft.description),
        whenToUse: str(draft.whenToUse),
        modelInvocable: draft.modelInvocable !== false,
        userInvocable: draft.userInvocable !== false,
        kind: draft.kind === 'flat' ? 'flat' : 'bundle',
        rootId: str(draft.rootId),
        body: typeof draft.body === 'string' ? draft.body : '',
      }
    }

    function buildPayload(mode, draft, force, target) {
      var payload = {
        action: mode === 'edit' ? 'update' : 'create',
        rootId: draft.rootId,
        name: str(draft.name).trim(),
        description: str(draft.description).trim(),
        whenToUse: str(draft.whenToUse).trim(),
        modelInvocable: draft.modelInvocable !== false,
        userInvocable: draft.userInvocable !== false,
        body: typeof draft.body === 'string' ? draft.body : '',
        force: force === true,
      }
      if (mode === 'edit') {
        payload.relPath = str(target && target.relPath)
        payload.expectedSha256 = str(target && target.expectedSha256)
      } else {
        payload.kind = draft.kind === 'flat' ? 'flat' : 'bundle'
      }
      return payload
    }

    function SkillEditor(props) {
      var tr = props.tr
      var mode = props.mode === 'edit' ? 'edit' : 'create'
      var target = props.target && typeof props.target === 'object' ? props.target : {}
      var roots = arr(props.roots)
      var draftState = React.useState(function () {
        return copyDraft(props.draft)
      })
      var draft = draftState[0]
      var setDraft = draftState[1]
      var validationState = React.useState(null)
      var validation = validationState[0]
      var setValidation = validationState[1]
      var touchedState = React.useState(false)
      var touched = touchedState[0]
      var setTouched = touchedState[1]
      var validatingState = React.useState(false)
      var validating = validatingState[0]
      var setValidating = validatingState[1]
      var validateErrorState = React.useState('')
      var validateError = validateErrorState[0]
      var setValidateError = validateErrorState[1]
      var savingState = React.useState(false)
      var saving = savingState[0]
      var setSaving = savingState[1]
      var saveErrorState = React.useState('')
      var saveError = saveErrorState[0]
      var setSaveError = saveErrorState[1]
      var forceState = React.useState(false)
      var force = forceState[0]
      var setForce = forceState[1]
      var nameRef = React.useRef(null)
      var descRef = React.useRef(null)
      var mountedRef = React.useRef(true)
      var validateSeq = React.useRef(0)
      React.useEffect(function () {
        mountedRef.current = true
        var focusTarget = mode === 'edit' ? descRef.current : nameRef.current
        if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus()
        return function () {
          mountedRef.current = false
        }
      }, [])

      function update(field, value) {
        setTouched(true)
        setSaveError('')
        setDraft(function (previous) {
          var next = merged({}, previous)
          next[field] = value
          return next
        })
      }

      var validateKey = [
        draft.name,
        draft.description,
        draft.whenToUse,
        draft.body,
        draft.modelInvocable,
        draft.userInvocable,
        draft.kind,
        draft.rootId,
      ].join('\u0000')

      React.useEffect(
        function () {
          if (!touched) return undefined
          var seq = ++validateSeq.current
          setValidating(true)
          setValidateError('')
          var payload = buildPayload(mode, draft, false, target)
          var timer = setTimeout(function () {
            postJson(withCwdPath('/api/validate', props.cwd), payload)
              .then(function (response) {
                if (!mountedRef.current || seq !== validateSeq.current) return
                var body = response.body || {}
                var errors = arr(body.errors)
                var conflicts = arr(body.conflicts)
                var warnings = arr(body.warnings)
                if (errors.length > 0 || conflicts.length > 0 || warnings.length > 0 || body.ok === false) {
                  setValidation({ errors: errors, conflicts: conflicts, warnings: warnings })
                } else if (response.ok) {
                  setValidation({ errors: [], conflicts: [], warnings: [] })
                } else {
                  setValidation(null)
                  setValidateError(envelopeMessage(body) || tr('error.http', { status: response.status }))
                }
              })
              .then(null, function (error) {
                if (!mountedRef.current || seq !== validateSeq.current) return
                setValidation(null)
                setValidateError(networkMessage(error, tr))
              })
              .then(function () {
                if (!mountedRef.current || seq !== validateSeq.current) return
                setValidating(false)
              })
          }, VALIDATE_DEBOUNCE_MS)
          return function () {
            clearTimeout(timer)
          }
        },
        [validateKey],
      )

      var errors = validation ? arr(validation.errors) : []
      var conflicts = validation ? arr(validation.conflicts) : []
      var warnings = validation ? arr(validation.warnings) : []
      var blocking = blockingConflicts(conflicts)
      var forceable = forceableConflicts(conflicts)
      var fieldErrors = {}
      var generalErrors = []
      var knownFields = { name: true, description: true, whenToUse: true, body: true, rootId: true, kind: true }
      for (var i = 0; i < errors.length; i++) {
        var errorItem = errors[i]
        var field = str(errorItem && errorItem.field)
        if (field && hasOwn(knownFields, field)) {
          if (!hasOwn(fieldErrors, field)) fieldErrors[field] = str(errorItem && errorItem.message) || tr('error.action')
        } else {
          generalErrors.push(str(errorItem && errorItem.message) || tr('error.action'))
        }
      }
      var blockingNotForceable = blocking.length > 0 && !forceable
      var blockedByConflicts = blocking.length > 0 && !force
      var invalid = errors.length > 0 || blockedByConflicts
      var filled = str(draft.name).trim().length > 0 && str(draft.description).trim().length > 0
      var canSave = !saving && !invalid && filled
      var writable = roots.length > 0

      function onSave(event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        if (saving) return
        setTouched(true)
        if (!filled || invalid) {
          setSaveError(errors.length > 0 || blocking.length > 0 ? tr('editor.fixErrors') : '')
          return
        }
        setSaving(true)
        setSaveError('')
        var payload = buildPayload(mode, draft, force && forceable, target)
        postJson(withCwdPath('/api/save', props.cwd), payload)
          .then(function (response) {
            if (!mountedRef.current) return
            var body = response.body || {}
            if (response.ok && body.ok === true) {
              props.onSaved(body)
              return
            }
            var nextErrors = arr(body.errors)
            var nextConflicts = arr(body.conflicts)
            var nextWarnings = arr(body.warnings)
            if (nextErrors.length > 0 || nextConflicts.length > 0 || nextWarnings.length > 0) {
              setValidation({ errors: nextErrors, conflicts: nextConflicts, warnings: nextWarnings })
            }
            setSaveError(envelopeMessage(body) || tr('error.saveFailed'))
            setSaving(false)
          })
          .then(null, function (error) {
            if (!mountedRef.current) return
            setSaveError(networkMessage(error, tr))
            setSaving(false)
          })
      }

      function fieldError(field) {
        return hasOwn(fieldErrors, field) ? fieldErrors[field] : ''
      }

      function fieldShell(labelKey, counter, children, fieldKey) {
        var error = fieldError(fieldKey)
        return h(
          'div',
          { className: 'dsm-field' },
          h(
            'div',
            { className: 'dsm-label-row' },
            h('label', { className: 'dsm-label', htmlFor: 'dsm-f-' + fieldKey }, tr(labelKey)),
            counter ? h('span', { className: 'dsm-counter' }, counter) : null,
          ),
          children,
          error ? h('p', { className: 'dsm-field-error', role: 'alert' }, error) : null,
        )
      }

      var title = mode === 'edit' ? tr('editor.editTitle') : tr('editor.newTitle')
      var subtitle = mode === 'edit' ? tr('editor.editSubtitle') : tr('editor.newSubtitle')
      var rootSelect = null
      if (mode === 'edit') {
        var editRootLabel = ''
        for (var r = 0; r < roots.length; r++) {
          if (roots[r] && roots[r].id === draft.rootId) editRootLabel = str(roots[r].label) || str(roots[r].id)
        }
        rootSelect = h(
          'div',
          { className: 'dsm-field' },
          h('div', { className: 'dsm-label-row' }, h('span', { className: 'dsm-label' }, tr('field.root'))),
          h(
            'div',
            { className: 'dsm-static' },
            h('span', { className: 'dsm-badge dsm-badge--muted' }, editRootLabel || draft.rootId || '—'),
          ),
          fieldError('rootId') ? h('p', { className: 'dsm-field-error', role: 'alert' }, fieldError('rootId')) : null,
        )
      } else {
        rootSelect = fieldShell(
          'field.root',
          '',
          h(
            'select',
            {
              id: 'dsm-f-rootId',
              className: 'dsm-select',
              value: draft.rootId,
              disabled: saving,
              onChange: function (event) {
                update('rootId', event.target.value)
              },
            },
            roots.map(function (root) {
              return h('option', { key: str(root.id), value: str(root.id) }, str(root.label) || str(root.id))
            }),
          ),
          'rootId',
        )
      }

      var kindControl = null
      if (mode === 'edit') {
        kindControl = h(
          'div',
          { className: 'dsm-static' },
          h('span', { className: 'dsm-badge dsm-badge--muted' }, tr('field.kind')),
          h('span', null, draft.kind === 'flat' ? tr('field.kindFlat') : tr('field.kindBundle')),
        )
      } else {
        kindControl = h(
          'div',
          { className: 'dsm-field' },
          h('div', { className: 'dsm-label-row' }, h('span', { className: 'dsm-label' }, tr('field.kind'))),
          h(ChoiceSeg, {
            label: tr('field.kind'),
            value: draft.kind,
            options: [
              { value: 'bundle', label: tr('field.kindBundle') },
              { value: 'flat', label: tr('field.kindFlat') },
            ],
            onChange: function (value) {
              update('kind', value)
            },
          }),
          h('p', { className: 'dsm-hint' }, tr('field.kindHint')),
          fieldError('kind') ? h('p', { className: 'dsm-field-error' }, fieldError('kind')) : null,
        )
      }

      return h(
        'div',
        { className: 'dsm-card dsm-editor', 'data-dsm': 'editor' },
        h(
          'div',
          { className: 'dsm-editor-head' },
          h('h2', { className: 'dsm-editor-title', id: 'dsm-editor-title' }, title),
          h('p', { className: 'dsm-note' }, subtitle),
        ),
        h(
          'form',
          {
            className: 'dsm-editor-body',
            onSubmit: onSave,
            noValidate: true,
            'aria-labelledby': 'dsm-editor-title',
          },
          fieldShell(
            'field.name',
            tr('field.counter', { current: String(draft.name.length), max: String(NAME_MAX) }),
            h('input', {
              id: 'dsm-f-name',
              ref: nameRef,
              className: 'dsm-input',
              type: 'text',
              value: draft.name,
              maxLength: NAME_MAX,
              disabled: mode === 'edit' || saving,
              autoComplete: 'off',
              spellCheck: false,
              'aria-invalid': fieldError('name') ? 'true' : 'false',
              onChange: function (event) {
                update('name', event.target.value)
              },
            }),
            'name',
          ),
          mode === 'edit' ? h('p', { className: 'dsm-hint' }, tr('field.nameLocked')) : h('p', { className: 'dsm-hint' }, tr('field.nameHint')),
          fieldShell(
            'field.description',
            tr('field.counter', { current: String(draft.description.length), max: String(DESCRIPTION_MAX) }),
            h('textarea', {
              id: 'dsm-f-description',
              ref: descRef,
              className: 'dsm-textarea',
              rows: 3,
              value: draft.description,
              maxLength: DESCRIPTION_MAX,
              disabled: saving,
              placeholder: tr('field.descriptionPlaceholder'),
              'aria-invalid': fieldError('description') ? 'true' : 'false',
              onChange: function (event) {
                update('description', event.target.value)
              },
            }),
            'description',
          ),
          h('p', { className: 'dsm-hint' }, tr('field.descriptionHint')),
          fieldShell(
            'field.whenToUse',
            tr('field.counter', { current: String(draft.whenToUse.length), max: String(WHEN_MAX) }),
            h('textarea', {
              id: 'dsm-f-whenToUse',
              className: 'dsm-textarea',
              rows: 2,
              value: draft.whenToUse,
              maxLength: WHEN_MAX,
              disabled: saving,
              placeholder: tr('field.whenToUsePlaceholder'),
              'aria-invalid': fieldError('whenToUse') ? 'true' : 'false',
              onChange: function (event) {
                update('whenToUse', event.target.value)
              },
            }),
            'whenToUse',
          ),
          h('p', { className: 'dsm-hint' }, tr('field.whenToUseHint')),
          h(
            'div',
            { className: 'dsm-row2' },
            rootSelect,
            kindControl,
          ),
          h(
            'div',
            { className: 'dsm-field', role: 'group', 'aria-labelledby': 'dsm-invocation-label' },
            h('span', { className: 'dsm-label', id: 'dsm-invocation-label' }, tr('field.invocation')),
            h(
              'label',
              { className: 'dsm-check' },
              h('input', {
                type: 'checkbox',
                checked: draft.modelInvocable,
                disabled: saving,
                onChange: function (event) {
                  update('modelInvocable', event.target.checked)
                },
              }),
              h('span', { className: 'dsm-check-text' }, h('span', null, tr('field.modelInvocable'))),
            ),
            h(
              'label',
              { className: 'dsm-check' },
              h('input', {
                type: 'checkbox',
                checked: draft.userInvocable,
                disabled: saving,
                onChange: function (event) {
                  update('userInvocable', event.target.checked)
                },
              }),
              h('span', { className: 'dsm-check-text' }, h('span', null, tr('field.userInvocable'))),
            ),
          ),
          fieldShell(
            'field.body',
            '',
            h('textarea', {
              id: 'dsm-f-body',
              className: 'dsm-textarea dsm-textarea--body',
              rows: 10,
              value: draft.body,
              disabled: saving,
              placeholder: tr('field.bodyPlaceholder'),
              spellCheck: false,
              onChange: function (event) {
                update('body', event.target.value)
              },
            }),
            'body',
          ),
          h('p', { className: 'dsm-hint' }, tr('field.bodyHint')),
          generalErrors.length > 0
            ? h(
                'div',
                { className: 'dsm-errors', role: 'alert' },
                h('p', { className: 'dsm-label' }, tr('editor.errorsTitle')),
                generalErrors.map(function (message, index) {
                  return h('p', { key: 'general-' + index, className: 'dsm-error-item' }, message)
                }),
              )
            : null,
          blocking.length > 0
            ? h(
                'div',
                { className: 'dsm-errors', role: 'alert' },
                h('p', { className: 'dsm-label' }, tr('editor.conflictsTitle')),
                blocking.map(function (conflict, index) {
                  var roots = conflictRoots(conflict)
                  var kindKey = conflictKindKey(conflict && conflict.code)
                  return h(
                    'p',
                    { key: 'block-' + index, className: 'dsm-error-item' },
                    (kindKey ? tr(kindKey) + ': ' : '') + (str(conflict && conflict.message) || '') + (roots.length > 0 ? ' (' + tr('conflict.entries', { roots: roots.join(', ') }) + ')' : ''),
                  )
                }),
              )
            : null,
          forceable
            ? h(
                'label',
                { className: 'dsm-check' },
                h('input', {
                  type: 'checkbox',
                  checked: force,
                  disabled: saving,
                  onChange: function (event) {
                    setForce(event.target.checked)
                  },
                }),
                h('span', { className: 'dsm-check-text' }, h('span', null, tr('field.force')), h('span', { className: 'dsm-hint' }, tr('field.forceHint'))),
              )
            : null,
          blockingNotForceable ? h('p', { className: 'dsm-hint' }, tr('editor.forceOnly')) : null,
          warnings.length > 0
            ? h(
                'div',
                { className: 'dsm-errors dsm-errors--warn', role: 'status' },
                h('p', { className: 'dsm-label' }, tr('editor.warningsTitle')),
                warnings.map(function (warning, index) {
                  return h('p', { key: 'warn-' + index, className: 'dsm-warning-item' }, str(warning && (warning.message || warning.code)) || '')
                }),
              )
            : null,
          h(
            'div',
            { className: 'dsm-validation' + (validation && validation.errors.length === 0 && blocking.length === 0 ? ' dsm-validation--ok' : '') },
            validating ? h(Spinner) : null,
            h(
              'span',
              null,
              validateError
                ? validateError
                : validating
                  ? tr('editor.checking')
                  : errors.length > 0 || blocking.length > 0
                    ? tr('editor.invalid')
                    : validation
                      ? tr('editor.valid')
                      : '',
            ),
          ),
          saveError ? h('p', { className: 'dsm-note dsm-note--error', role: 'alert' }, saveError) : null,
          !writable && mode === 'create' ? h('p', { className: 'dsm-note dsm-note--warn', role: 'alert' }, tr('editor.noWritableRoots')) : null,
          h(
            'div',
            { className: 'dsm-editor-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsm-btn dsm-btn--ghost',
                onClick: props.onCancel,
                disabled: saving,
              },
              tr('action.cancel'),
            ),
            h(
              'button',
              {
                type: 'submit',
                className: 'dsm-btn dsm-btn--accent',
                disabled: !canSave || !writable,
                'data-dsm': 'save',
              },
              saving ? h(Spinner) : null,
              saving ? tr('action.saving') : tr('action.save'),
            ),
          ),
        ),
      )
    }

    // -----------------------------------------------------------------------
    // Section component (created inside apply so it can close over the live
    // translator / cwd resolver without touching ctx from render).
    // -----------------------------------------------------------------------
    function makeSectionComponent(translate, getCwd) {
      return function SkillsSection(props) {
        ensureStyles()
        var tr = tOf(props, translate)

        var phaseState = React.useState('loading')
        var phase = phaseState[0]
        var setPhase = phaseState[1]
        var dataState = React.useState(null)
        var data = dataState[0]
        var setData = dataState[1]
        var loadErrorState = React.useState('')
        var loadError = loadErrorState[0]
        var setLoadError = loadErrorState[1]
        var tabState = React.useState('installed')
        var tab = tabState[0]
        var setTab = tabState[1]
        var queryState = React.useState('')
        var query = queryState[0]
        var setQuery = queryState[1]
        var editorState = React.useState(null)
        var editor = editorState[0]
        var setEditor = editorState[1]
        var confirmDeleteState = React.useState(null)
        var confirmDelete = confirmDeleteState[0]
        var setConfirmDelete = confirmDeleteState[1]
        var busyKeyState = React.useState(null)
        var busyKey = busyKeyState[0]
        var setBusyKey = busyKeyState[1]
        var refreshingState = React.useState(false)
        var refreshing = refreshingState[0]
        var setRefreshing = refreshingState[1]
        var rowErrorsState = React.useState({})
        var rowErrors = rowErrorsState[0]
        var setRowErrors = rowErrorsState[1]
        var rowForceState = React.useState({})
        var rowForce = rowForceState[0]
        var setRowForce = rowForceState[1]
        var confirmUpdateState = React.useState(null)
        var confirmUpdate = confirmUpdateState[0]
        var setConfirmUpdate = confirmUpdateState[1]
        var messageState = React.useState(null)
        var message = messageState[0]
        var setMessage = messageState[1]
        var mountedRef = React.useRef(true)
        var loadSeqRef = React.useRef(0)
        var editorSeqRef = React.useRef(0)
        var addRef = React.useRef(null)
        var rootRef = React.useRef(null)
        var refocusListRef = React.useRef(false)

        React.useEffect(function () {
          mountedRef.current = true
          return function () {
            mountedRef.current = false
          }
        }, [])

        function setRowError(key, text) {
          setRowErrors(function (previous) {
            var next = merged({}, previous)
            if (text) next[key] = text
            else delete next[key]
            return next
          })
          setRowForce(function (previous) {
            var next = merged({}, previous)
            delete next[key]
            return next
          })
        }

        function setRowForceFlag(key, value) {
          setRowForce(function (previous) {
            var next = merged({}, previous)
            if (value) next[key] = true
            else delete next[key]
            return next
          })
        }

        function loadState(silent) {
          var seq = ++loadSeqRef.current
          if (!silent) setPhase('loading')
          var cwd = typeof getCwd === 'function' ? getCwd() : null
          return fetchJson(stateUrl(cwd))
            .then(function (response) {
              if (!mountedRef.current || seq !== loadSeqRef.current) return null
              var body = response.body
              if (response.ok && body && body.ok === true && body.roots !== undefined) {
                setData(body)
                setPhase('ready')
                setLoadError('')
                return body
              }
              var text = envelopeMessage(body)
              if (!text && response.status > 0) text = tr('error.http', { status: response.status })
              setLoadError(text || tr('error.load'))
              setPhase('error')
              return null
            })
            .then(null, function (error) {
              if (!mountedRef.current || seq !== loadSeqRef.current) return null
              setLoadError(networkMessage(error, tr))
              setPhase('error')
              return null
            })
        }

        React.useEffect(
          function () {
            loadState(false)
          },
          [],
        )

        React.useEffect(
          function () {
            if (editor === null && refocusListRef.current) {
              refocusListRef.current = false
              if (addRef.current && typeof addRef.current.focus === 'function') addRef.current.focus()
            }
          },
          [editor],
        )

        function refresh() {
          if (refreshing) return
          setRefreshing(true)
          setMessage(null)
          loadState(true).then(function (body) {
            if (!mountedRef.current) return
            setRefreshing(false)
            if (body) setMessage({ text: tr('status.refreshed'), tone: 'ok' })
          })
        }

        function startCreate() {
          var roots = writableRoots(data)
          if (roots.length === 0) return
          editorSeqRef.current += 1
          setConfirmDelete(null)
          setMessage(null)
          setEditor({
            seq: editorSeqRef.current,
            mode: 'create',
            status: 'ready',
            draft: {
              name: '',
              description: '',
              whenToUse: '',
              modelInvocable: true,
              userInvocable: true,
              kind: 'bundle',
              rootId: roots[0].id,
              body: '',
            },
          })
        }

        function startEdit(skill) {
          editorSeqRef.current += 1
          var seq = editorSeqRef.current
          setConfirmDelete(null)
          setMessage(null)
          setEditor({ seq: seq, mode: 'edit', status: 'loading', skill: skill, loadError: '' })
          var url =
            API_BASE +
            '/api/skill?rootId=' +
            encodeURIComponent(str(skill && skill.rootId)) +
            '&relPath=' +
            encodeURIComponent(str(skill && skill.relPath)) +
            (isAbsolutePath(cwd) ? '&cwd=' + encodeURIComponent(cwd) : '')
          fetchJson(url)
            .then(function (response) {
              if (!mountedRef.current || editorSeqRef.current !== seq) return
              var body = response.body
              if (response.ok && body && body.ok === true && body.skill && typeof body.skill === 'object') {
                var entry = body.skill
                setEditor({
                  seq: seq,
                  mode: 'edit',
                  status: 'ready',
                  skill: entry,
                  target: {
                    rootId: str(entry.rootId) || str(skill.rootId),
                    relPath: str(entry.relPath) || str(skill.relPath),
                    expectedSha256: str(entry.sha256) || str(skill.sha256),
                  },
                  draft: {
                    name: str(entry.name) || str(skill.name),
                    description: str(entry.description),
                    whenToUse: str(entry.whenToUse),
                    modelInvocable: entry.modelInvocable !== false,
                    userInvocable: entry.userInvocable !== false,
                    kind: str(entry.kind) || str(skill.kind),
                    rootId: str(entry.rootId) || str(skill.rootId),
                    body: stripFrontmatter(entry.content),
                  },
                })
                return
              }
              var text = envelopeMessage(body)
              setEditor({ seq: seq, mode: 'edit', status: 'error', skill: skill, loadError: text || tr('error.loadSkill') })
            })
            .then(null, function (error) {
              if (!mountedRef.current || editorSeqRef.current !== seq) return
              setEditor({ seq: seq, mode: 'edit', status: 'error', skill: skill, loadError: networkMessage(error, tr) })
            })
        }

        function closeEditor() {
          refocusListRef.current = true
          setEditor(null)
        }

        function handleSaved(body) {
          var outcome = registryOutcome(body && body.registry, tr)
          refocusListRef.current = true
          setEditor(null)
          setMessage({ text: outcome.text, tone: outcome.tone, detail: outcome.detail })
          loadState(true)
        }

        function deleteSkill(skill, key) {
          if (busyKey !== null) return
          setBusyKey(key)
          setRowError(key, '')
          postJson(withCwdPath('/api/delete', cwd), {
            rootId: str(skill && skill.rootId),
            relPath: str(skill && skill.relPath),
            expectedSha256: str(skill && skill.sha256),
          })
            .then(function (response) {
              if (!mountedRef.current) return
              var body = response.body || {}
              if (response.ok && body.ok === true) {
                setConfirmDelete(null)
                setMessage({ text: tr('status.deleted', { name: str(skill && skill.name) }), tone: 'ok' })
                return loadState(true)
              }
              var text = envelopeMessage(body) || tr('error.deleteFailed')
              setRowError(key, text)
              throw new Error('handled')
            })
            .then(null, function (error) {
              if (!mountedRef.current) return
              if (error && error.message === 'handled') return
              setRowError(key, networkMessage(error, tr))
            })
            .then(function () {
              if (!mountedRef.current) return
              setBusyKey(null)
            })
        }

        function installItem(library, item, options) {
          var opts = options || {}
          var key = 'install:' + str(library && library.id) + ':' + str(item && item.relPath)
          if (busyKey !== null) return
          setBusyKey(key)
          setRowError(key, '')
          var payload = {
            libraryId: str(library && library.id),
            relPath: str(item && item.relPath),
            overwrite: opts.overwrite === true,
            force: opts.force === true,
          }
          if (opts.expectedSha256) payload.expectedSha256 = opts.expectedSha256
          postJson(withCwdPath('/api/install', cwd), payload)
            .then(function (response) {
              if (!mountedRef.current) return
              var body = response.body || {}
              if (response.ok && body.ok === true) {
                setConfirmUpdate(null)
                setMessage({ text: tr(payload.overwrite ? 'status.updated' : 'status.installed', { name: str(item && item.name) }), tone: 'ok' })
                return loadState(true)
              }
              var text = envelopeMessage(body) || tr('error.installFailed')
              setRowError(key, text)
              var code = body.error && typeof body.error.code === 'string' ? body.error.code : ''
              if (response.status === 409 && (code === 'duplicate-name' || code === 'alias-collision')) {
                setRowForceFlag(key, true)
              }
              return null
            })
            .then(null, function (error) {
              if (!mountedRef.current) return
              setRowError(key, networkMessage(error, tr))
            })
            .then(function () {
              if (!mountedRef.current) return
              setBusyKey(null)
            })
        }

        function startUpdate(library, item, key) {
          setConfirmUpdate(key)
        }

        function confirmUpdateInstall(library, item) {
          var installed = item && item.installed && typeof item.installed === 'object' ? item.installed : {}
          installItem(library, item, {
            overwrite: true,
            expectedSha256: str(installed.sha256),
          })
        }

        function cancelUpdate() {
          setConfirmUpdate(null)
        }

        function onDeleteStart(skill) {
          var key = str(skill && skill.id) || str(skill && skill.rootId) + ':' + str(skill && skill.relPath)
          setConfirmDelete(key)
          setRowError(key, '')
          setMessage(null)
        }

        function onDeleteCancel() {
          setConfirmDelete(null)
        }

        function onDeleteConfirm(skill) {
          var key = str(skill && skill.id) || str(skill && skill.rootId) + ':' + str(skill && skill.relPath)
          deleteSkill(skill, key)
        }

        function onKeyDown(event) {
          if (!event || event.key !== 'Escape') return
          if (editor !== null) {
            event.preventDefault()
            event.stopPropagation()
            closeEditor()
            return
          }
          if (confirmDelete !== null) {
            event.preventDefault()
            event.stopPropagation()
            setConfirmDelete(null)
            return
          }
          if (confirmUpdate !== null) {
            event.preventDefault()
            event.stopPropagation()
            setConfirmUpdate(null)
          }
        }

        var roots = writableRoots(data)
        var cwd = typeof getCwd === 'function' ? getCwd() : null
        var canAdd = phase === 'ready' && roots.length > 0 && editor === null
        var heroActions = []
        if (editor === null) {
          heroActions.push(
            h(
              'button',
              {
                key: 'refresh',
                type: 'button',
                className: 'dsm-btn dsm-btn--ghost',
                onClick: refresh,
                disabled: refreshing || phase === 'loading' || busyKey !== null,
                'aria-label': tr('aria.refresh'),
                title: tr('action.refresh'),
                'data-dsm': 'refresh',
              },
              refreshing ? h(Spinner) : h(IconRefresh),
              refreshing ? tr('refreshing') : tr('action.refresh'),
            ),
          )
          heroActions.push(
            h(
              'button',
              {
                key: 'add',
                ref: addRef,
                type: 'button',
                className: 'dsm-btn dsm-btn--accent',
                onClick: startCreate,
                disabled: !canAdd,
                title: roots.length === 0 ? tr('editor.noWritableRoots') : tr('aria.add'),
                'aria-label': tr('aria.add'),
                'data-dsm': 'add-skill',
              },
              h(IconPlus),
              tr('action.add'),
            ),
          )
        }

        var content = null
        if (editor !== null) {
          if (editor.status === 'loading') {
            content = h(
              'div',
              { className: 'dsm-loading', role: 'status' },
              h(Spinner),
              h('span', null, tr('editor.loading')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsm-btn dsm-btn--sm dsm-btn--ghost',
                  onClick: closeEditor,
                  style: { marginLeft: 'auto' },
                },
                tr('action.cancel'),
              ),
            )
          } else if (editor.status === 'error') {
            content = h(
              'div',
              { className: 'dsm-card dsm-card--pad', role: 'alert' },
              h('p', { className: 'dsm-note dsm-note--error' }, editor.loadError || tr('error.loadSkill')),
              h(
                'div',
                { className: 'dsm-editor-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsm-btn dsm-btn--ghost',
                    onClick: closeEditor,
                  },
                  tr('action.cancel'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsm-btn dsm-btn--accent',
                    onClick: function () {
                      startEdit(editor.skill)
                    },
                  },
                  tr('action.retry'),
                ),
              ),
            )
          } else {
            content = h(SkillEditor, {
              key: 'editor-' + String(editor.seq),
              tr: tr,
              mode: editor.mode,
              draft: editor.draft,
              target: editor.target || {},
              roots: roots,
              cwd: cwd,
              onCancel: closeEditor,
              onSaved: handleSaved,
            })
          }
        } else if (phase === 'loading') {
          content = h(
            'div',
            { className: 'dsm-loading', role: 'status' },
            h(Spinner),
            h('span', null, tr('loading')),
          )
        } else if (phase === 'error') {
          content = h(
            'div',
            { className: 'dsm-card dsm-card--pad', role: 'alert' },
            h('h2', { className: 'dsm-editor-title' }, tr('error.title')),
            h('p', { className: 'dsm-note dsm-note--error' }, loadError || tr('error.load')),
            h(
              'div',
              { className: 'dsm-editor-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsm-btn dsm-btn--accent',
                  onClick: function () {
                    loadState(false)
                  },
                },
                tr('action.retry'),
              ),
            ),
          )
        } else {
          content = h(
            React.Fragment,
            null,
            h(Stats, { tr: tr, data: data }),
            h(
              'div',
              { className: 'dsm-toolbar' },
              h(
                'div',
                { className: 'dsm-search' },
                h('span', { className: 'dsm-search-icon' }, h(IconSearch)),
                h('input', {
                  className: 'dsm-input',
                  type: 'search',
                  value: query,
                  placeholder: tr('search.placeholder'),
                  'aria-label': tr('search.label'),
                  onChange: function (event) {
                    setQuery(event.target.value)
                  },
                  onKeyDown: function (event) {
                    if (event.key === 'Escape' && query) {
                      event.preventDefault()
                      event.stopPropagation()
                      setQuery('')
                    }
                  },
                  'data-dsm': 'search',
                }),
                query
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsm-search-clear',
                        onClick: function () {
                          setQuery('')
                        },
                        'aria-label': tr('action.clearSearch'),
                        title: tr('action.clearSearch'),
                      },
                      h(IconX),
                    )
                  : null,
              ),
              h(Tabs, { tr: tr, value: tab, onChange: setTab }),
            ),
            tab === 'installed'
              ? h(InstalledTab, {
                  tr: tr,
                  data: data,
                  query: query,
                  confirmDelete: confirmDelete,
                  busyKey: busyKey,
                  rowErrors: rowErrors,
                  onEdit: startEdit,
                  onDeleteStart: onDeleteStart,
                  onDeleteCancel: onDeleteCancel,
                  onDeleteConfirm: onDeleteConfirm,
                })
              : h(AvailableTab, {
                  tr: tr,
                  data: data,
                  query: query,
                  busyKey: busyKey,
                  confirmUpdate: confirmUpdate,
                  rowErrors: rowErrors,
                  rowForce: rowForce,
                  onInstall: installItem,
                  onUpdateStart: startUpdate,
                  onUpdateConfirm: confirmUpdateInstall,
                  onUpdateCancel: cancelUpdate,
                }),
          )
        }

        var messages = []
        if (message) {
          messages.push(
            h(LiveMessage, {
              key: 'status',
              tr: tr,
              message: message,
              onDismiss: function () {
                setMessage(null)
              },
            }),
          )
        }

        return h(
          'div',
          {
            ref: rootRef,
            className: 'dsm-root',
            role: 'region',
            onKeyDown: onKeyDown,
            'aria-labelledby': 'dsm-skills-title',
            'aria-busy': phase === 'loading' || refreshing || busyKey !== null ? 'true' : 'false',
            'data-dsm': 'skills-root',
          },
          h(
            'div',
            { className: 'dsm-hero' },
            h(
              'div',
              { className: 'dsm-hero-main' },
              h('p', { className: 'dsm-eyebrow' }, tr('section.eyebrow')),
              h('h2', { className: 'dsm-title', id: 'dsm-skills-title' }, tr('section.label')),
              h('p', { className: 'dsm-subtitle' }, tr('section.subtitle')),
            ),
            heroActions.length > 0 ? h('div', { className: 'dsm-hero-actions', role: 'group', 'aria-label': tr('aria.section') }, heroActions) : null,
          ),
          messages,
          content,
        )
      }
    }

    // -----------------------------------------------------------------------
    // apply(ctx) — defensive: never throw, register once, graceful fallbacks.
    // -----------------------------------------------------------------------
    function apply(ctx) {
      var slots = null
      try {
        slots = ctx.get('slots')
      } catch (error) {
        slots = null
      }
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return

      // Optional locale service: declare the namespace only when a face exists
      // (the renderer throws for an entry that declares an unprovided namespace).
      var localeFace = null
      try {
        var locale = ctx.get('locale')
        if (locale && typeof locale.bind === 'function' && typeof locale.register === 'function') localeFace = locale
      } catch (error) {
        localeFace = null
      }
      var localeOption = localeFace === null ? {} : { locale: NS }

      var dictionariesRegistered = false
      function ensureDictionary() {
        if (dictionariesRegistered) return
        dictionariesRegistered = true
        var live = null
        try {
          live = ctx.get('locale')
        } catch (error) {
          live = null
        }
        if (!live || typeof live.register !== 'function') return
        var register = function () {
          try {
            return live.register(NS, { zh: zh, en: en })
          } catch (error) {
            // A client reload can re-run apply while the previous registration
            // still stands; the equal dictionaries already in place stay valid.
            return undefined
          }
        }
        try {
          if (typeof ctx.effect === 'function') ctx.effect(register)
          else register()
        } catch (error) {
          /* dictionary registration is best-effort */
        }
      }
      ensureDictionary()

      function translate(key, params) {
        ensureDictionary()
        var live = null
        try {
          live = ctx.get('locale')
        } catch (error) {
          live = null
        }
        if (live && typeof live.bind === 'function') {
          try {
            var bound = live.bind(NS)
            var text = params === undefined ? bound(key) : bound(key, params)
            if (typeof text === 'string' && text !== key) return text
          } catch (error) {
            /* fall back to the local dictionary */
          }
        }
        return fallbackTranslate(key, params)
      }

      // Optional cwd: project skill roots are only scanned when a cwd is
      // supplied. The sessions service is optional and its shape is defensive.
      function getCwd() {
        try {
          var sessions = ctx.get('sessions')
          if (!sessions || typeof sessions !== 'object') return null
          var snapshot = null
          if (sessions.list && typeof sessions.list.getSnapshot === 'function') snapshot = sessions.list.getSnapshot()
          else if (typeof sessions.getSnapshot === 'function') snapshot = sessions.getSnapshot()
          if (!snapshot || typeof snapshot !== 'object' || !snapshot.byId || typeof snapshot.byId !== 'object') return null
          var byId = snapshot.byId
          var ids = Object.keys(byId)
          if (ids.length === 0) return null
          var entry = null
          var activeId = typeof snapshot.activeId === 'string' ? snapshot.activeId : null
          var currentId = typeof snapshot.currentId === 'string' ? snapshot.currentId : null
          if (activeId && byId[activeId]) entry = byId[activeId]
          else if (currentId && byId[currentId]) entry = byId[currentId]
          if (!entry) {
            for (var i = 0; i < ids.length; i++) {
              var candidate = byId[ids[i]]
              if (candidate && candidate.retainedBy && (candidate.retainedBy.mainView || 0) > 0) {
                entry = candidate
                break
              }
            }
          }
          if (!entry) entry = byId[ids[0]]
          if (!entry || typeof entry !== 'object') return null
          if (typeof entry.cwd === 'string' && entry.cwd.length > 0) return entry.cwd
          if (entry.workspace && typeof entry.workspace === 'object' && typeof entry.workspace.cwd === 'string' && entry.workspace.cwd.length > 0) {
            return entry.workspace.cwd
          }
        } catch (error) {
          return null
        }
        return null
      }

      // One <style> element, owned by the plugin fiber.
      try {
        if (typeof ctx.effect === 'function') ctx.effect(ensureStyles)
        else ensureStyles()
      } catch (error) {
        ensureStyles()
      }

      var Section = makeSectionComponent(translate, getCwd)
      try {
        slots.inject('settings.section', function () {
          try {
            return slots.register(
              merged(
                {
                  name: 'settings.section',
                  id: 'skills',
                  order: 40,
                  label: function () {
                    return translate('section.label')
                  },
                },
                localeOption,
              ),
              Section,
            )
          } catch (error) {
            return undefined
          }
        })
      } catch (error) {
        /* registration is best-effort; a failed reload must not break apply */
      }
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
