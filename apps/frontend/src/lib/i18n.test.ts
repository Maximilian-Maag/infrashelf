import { describe, it, expect } from 'vitest'
import { SUPPORTED_LANGUAGES, LANGUAGE_OPTIONS, t, isValidLang, type Translations } from './i18n'

// The English table is the reference: t() falls back to it per key, so it is the
// only one the type system requires to be complete. That fallback is a safety
// net, not a plan — a language silently rendering English is the bug this suite
// exists to catch.

describe('i18n', () => {
  it('exposes 25 EU languages', () => {
    expect(SUPPORTED_LANGUAGES.length).toBe(25)
    expect(SUPPORTED_LANGUAGES.map((l) => l.code)).toContain('de')
    expect(SUPPORTED_LANGUAGES.map((l) => l.code)).toContain('en')
  })

  it('offers every supported language when a product is written or translated', () => {
    // The two admin product forms each hardcoded four (en/de/fr/es), so a product
    // could be machine-translated into Polish and then not editable in Polish by
    // hand — and de-only or fr-only products were the normal case (issue #162).
    expect(LANGUAGE_OPTIONS.map((o) => o.value)).toEqual(SUPPORTED_LANGUAGES.map((l) => l.code))
    expect(LANGUAGE_OPTIONS).toHaveLength(25)
    // Labelled in the language itself: a language picker names languages the way
    // their own speakers do.
    expect(LANGUAGE_OPTIONS.find((o) => o.value === 'pl')?.label).toBe('Polski')
  })

  it('resolves a key for every supported language', () => {
    for (const { code } of SUPPORTED_LANGUAGES) {
      expect(t('catalog', code), `catalog missing for ${code}`).toBeTruthy()
    }
  })

  it('falls back to English for an unknown language instead of throwing', () => {
    expect(t('catalog', 'xx')).toBe(t('catalog', 'en'))
  })

  it('strips a region suffix before looking the language up', () => {
    expect(t('catalog', 'de-DE')).toBe(t('catalog', 'de'))
    expect(t('catalog', 'DE')).toBe(t('catalog', 'de'))
  })

  it('recognises supported languages and rejects others', () => {
    expect(isValidLang('de')).toBe(true)
    expect(isValidLang('de-AT')).toBe(true)
    expect(isValidLang('xx')).toBe(false)
  })

  // ── Completeness ──────────────────────────────────────────────────────────
  // The chrome and admin-header keys were added late; before this suite existed
  // they were present only for en + de and every other language quietly rendered
  // English. Assert per key per language so a new string cannot ship that way.
  const CHROME_KEYS: (keyof Translations)[] = [
    'mainNavigation', 'dismiss', 'close', 'search', 'skipToContent', 'breadcrumb',
    'ciSources', 'environments', 'costCenters', 'users', 'branding',
    'smtpConfiguration', 'aiConfiguration', 'exchangeRates', 'adminDashboard',
    'profileSettings', 'globalParameters',
    'categoriesSubtitle', 'ciSourcesSubtitle', 'environmentsSubtitle',
    'costCentersSubtitle', 'usersSubtitle', 'brandingSubtitle', 'smtpSubtitle',
    'aiSubtitle', 'exchangeRatesSubtitle', 'adminDashboardSubtitle',
    'profileSettingsSubtitle', 'globalParametersSubtitle',
    // Session management (#37). It lives on the settings page and every string
    // in it is a security decision the user is being asked to make, so a language
    // silently rendering English there is worse than most.
    'activeSessions', 'activeSessionsSubtitle',
  ]

  // The admin area (issue #100) went through the same trap: 16 components never
  // imported `t` at all, so every string there was a literal. These keys get the
  // same per-language guard as CHROME_KEYS, just with a higher wholesale
  // threshold — there are nearly seven times as many keys, and technical loan
  // words ("URL", "Port", "Root", cognates like "Model"/"Logo") scale with it.
  const ADMIN_KEYS: (keyof Translations)[] = [
    'save', 'copy', 'copied', 'regenerate', 'regenerating', 'working', 'activate',
    'deactivate', 'required', 'sensitive', 'requiredBadge', 'sensitiveBadge',
    'genericFailed', 'failedToCreateGeneric', 'failedToUpdateGeneric',
    'failedToDeleteGeneric', 'deleted', 'role', 'type', 'typeString', 'typeNumber',
    'typeBoolean', 'typeDropdown', 'roleProjectManager', 'roleAdmin', 'roleRoot',
    'addEnvironment', 'noEnvironmentsYet', 'ciSourceLabel', 'selectCiSourcePlaceholder',
    'webhookUrl', 'webhookToken', 'editEnvironment', 'webhookUrlKeepHint',
    'webhookTokenOutbound', 'webhookTokenOutboundHint', 'callbackSecretLabel',
    'callbackSecretHint', 'revealCurrent', 'deleteEnvironmentTitle',
    'regenerateSecretTitle', 'regenerateSecretConfirm', 'failedToLoadSecret',
    'failedToRegenerateSecret', 'failedToCopyClipboard', 'failedToDeleteEnvironment',
    'refreshRates', 'refreshing', 'currency', 'rateToEur', 'lastUpdated',
    'noExchangeRates', 'failedToLoadExchangeRates', 'failedToRefreshRates',
    'addParameter', 'noGlobalParametersYet', 'variableName', 'variableNameHint',
    'displayLabel', 'displayLabelHint', 'defaultValue', 'commaSeparatedOptions',
    'editParameter', 'deleteParameterTitle', 'deleteParameterPrompt',
    'failedToLoadParameters', 'addCostCenter', 'noCostCentersYet', 'code',
    'codePlaceholder', 'editCostCenter', 'deleteCostCenterTitle',
    'deleteCostCenterPrompt', 'failedToLoadCostCenters', 'addCategory',
    'noCategoriesYet', 'displayOrder', 'editCategory', 'deleteCategoryTitle',
    'deleteCategoryPrompt', 'categoryCreatedToast', 'categoryUpdatedToast',
    'categoryDeletedToast', 'failedToLoadCategories', 'manageCatalogProducts',
    'newProduct', 'category', 'language', 'noProductsYet', 'backToProducts',
    'productsTitle', 'productDetails', 'selectCategoryPlaceholder',
    'selectCategoryError', 'baseLanguage', 'languageEnglish', 'languageGerman',
    'languageFrench', 'languageSpanish', 'image', 'imageHintOptional',
    'imageTooLargePrefix', 'mbLimitSuffix', 'imageDescriptionLabel',
    'imageDescriptionHint', 'describeImageOrRemove', 'createProductButton',
    'failedToCreateProduct', 'imageCouldNotBeUploaded', 'editProductDetailsSubtitle',
    'deleteProductPrompt', 'productDeleteWarningActive', 'productDeleteWarningBody',
    'productDeleteWarningCascade', 'failedToDeleteProduct', 'productImage',
    'productCreatedPrefix', 'tryUploadingAgain', 'requiredForEveryImage',
    'saveDescription', 'imageFileLabel', 'imageFormatHintPlain', 'removeImage',
    'placeholderImageAltExample', 'describeBeforeUpload',
    'imageDescriptionRequiredError', 'uploadFailed', 'couldNotSaveDescription',
    'couldNotRemoveImage', 'imageUploaded', 'descriptionSaved', 'imageRemoved',
    'fileTooLargePrefix', 'addCiSource', 'noCiSourcesYet', 'url', 'provider',
    'accessToken', 'accessTokenKeepLabel', 'editCiSource', 'deleteCiSourceTitle',
    'failedToLoadCiSources', 'addUser', 'noUsersYet', 'createButton', 'editUser',
    'deleteUserTitle', 'deleteUserPrompt', 'failedToLoadUsers', 'userCreatedToast',
    'userUpdatedToast', 'userDeletedToast', 'brandingSettingsTitle', 'shopName',
    'subtitleLabel', 'primaryColor', 'primaryColorHint', 'secondaryColor',
    'secondaryColorHint', 'logo', 'logoPreviewAlt', 'logoHint', 'imprintTextLabel',
    'saveBranding', 'failedToSaveBranding', 'brandingSavedToast', 'colorPickerSuffix',
    'hexValueSuffix', 'invalidHexColor', 'contrastMeetsAA', 'contrastMeetsAAA',
    'contrastFailsAA', 'contrastAaRequires', 'contrastAaaRequires', 'smtpSettingsTitle', 'host', 'port', 'fromAddress',
    'username', 'passwordKeepHint', 'useTls', 'saveConfiguration', 'failedToSaveSmtp',
    'smtpConfigSavedToast', 'aiProviderSettingsTitle', 'apiEndpoint',
    'apiEndpointHint', 'apiKey', 'apiKeyKeepHint', 'model', 'failedToSaveAi',
    'aiConfigSavedToast',
    // Shared keys the admin screens depend on. They are not new here — most
    // predate this file — but the admin area is now the thing that breaks if one
    // of them is missing in a language, so the guard has to cover them too.
    'any', 'cancel', 'cannotBeUndone', 'categories', 'changelog', 'changelogHint', 'changes', 'compare', 'created', 'creating', 'date', 'delete', 'deleting', 'description', 'edit', 'email', 'environment', 'fromDate', 'loading', 'name', 'noChanges', 'noVersionHistory', 'password', 'product', 'saving', 'statusActive', 'system', 'toDate', 'user', 'versionHistory',
  ]

  // Shared by both key sets: collect the keys where a language's value is
  // byte-for-byte identical to English, then fail only if there are enough of
  // them to look like the fallback kicking in wholesale rather than a
  // sprinkling of genuine loan words and technical cognates.
  function expectRealTranslations(keys: (keyof Translations)[], maxWholesale: number) {
    const untranslated: string[] = []
    for (const { code } of SUPPORTED_LANGUAGES) {
      if (code === 'en') continue
      for (const key of keys) {
        const value = t(key, code)
        expect(value, `${code}.${key} does not resolve`).toBeTruthy()
        if (value === t(key, 'en')) untranslated.push(`${code}.${key}`)
      }
    }
    const perLanguage = new Map<string, number>()
    for (const entry of untranslated) {
      const code = entry.split('.')[0]
      perLanguage.set(code, (perLanguage.get(code) ?? 0) + 1)
    }
    const wholesale = [...perLanguage.entries()].filter(([, n]) => n > maxWholesale)
    expect(
      wholesale,
      `these languages look like they are falling back to English: ${wholesale
        .map(([c, n]) => `${c} (${n}/${keys.length})`)
        .join(', ')}`,
    ).toEqual([])
  }

  it('has a real translation for every chrome/admin key in every language', () => {
    expectRealTranslations(CHROME_KEYS, 4)
  })

  it('has a real translation for every admin-area key in every language (#100)', () => {
    expectRealTranslations(ADMIN_KEYS, 10)
  })

  it('never yields the string "undefined" for a known key', () => {
    for (const { code } of SUPPORTED_LANGUAGES) {
      for (const key of [...CHROME_KEYS, ...ADMIN_KEYS]) {
        expect(String(t(key, code))).not.toBe('undefined')
      }
    }
  })

  // The two-factor keys (issue #36) went in as one block across all 25 tables,
  // so they get the same per-key-per-language guard as the chrome keys above.
  const TWO_FACTOR_KEYS: (keyof Translations)[] = [
    'twoFactorAuth', 'twoFactorIntro', 'twoFactorOn', 'twoFactorOff',
    'twoFactorSetUp', 'twoFactorReplace', 'twoFactorScanHint',
    'twoFactorSetupKey', 'twoFactorCodeLabel', 'twoFactorCodeHint',
    'twoFactorActivate', 'twoFactorRecoveryCodes', 'twoFactorRecoveryHint',
    'twoFactorRecoveryLeft', 'twoFactorLoginHint', 'twoFactorVerifying',
    'twoFactorCurrentPassword', 'twoFactorLockedOut',
  ]

  it('has a real translation for every two-factor key in every language', () => {
    const untranslated: string[] = []
    for (const { code } of SUPPORTED_LANGUAGES) {
      if (code === 'en') continue
      for (const key of TWO_FACTOR_KEYS) {
        const value = t(key, code)
        expect(value, `${code}.${key} does not resolve`).toBeTruthy()
        // Identical to English means the key is absent and the fallback kicked
        // in. A few short labels legitimately match ("Active", "Activate"), so
        // collect rather than fail per key and check the count below.
        if (value === t(key, 'en')) untranslated.push(`${code}.${key}`)
      }
    }
    const perLanguage = new Map<string, number>()
    for (const entry of untranslated) {
      const code = entry.split('.')[0]
      perLanguage.set(code, (perLanguage.get(code) ?? 0) + 1)
    }
    const wholesale = [...perLanguage.entries()].filter(([, n]) => n > 4)
    expect(
      wholesale,
      `these languages look like they are falling back to English: ${wholesale
        .map(([c, n]) => `${c} (${n}/${TWO_FACTOR_KEYS.length})`)
        .join(', ')}`,
    ).toEqual([])
  })

  it('keeps subtitles as sentences and titles as labels', () => {
    for (const { code } of SUPPORTED_LANGUAGES) {
      // Titles are labels, so they should not be punctuated like prose.
      expect(t('adminDashboard', code), `${code} adminDashboard`).not.toMatch(/\.$/)
      expect(t('users', code), `${code} users`).not.toMatch(/\.$/)
      expect(t('activeSessions', code), `${code} activeSessions`).not.toMatch(/\.$/)
      // Subtitles are sentences.
      expect(t('usersSubtitle', code), `${code} usersSubtitle`).toMatch(/[.!?]$/)
      expect(t('activeSessionsSubtitle', code), `${code} activeSessionsSubtitle`).toMatch(/[.!?]$/)
    }
  })

  // ── Session management (#37) ──────────────────────────────────────────────
  // Column headers and the two actions. Not in CHROME_KEYS because several of
  // these legitimately match English in some languages ("IP" is "IP" nearly
  // everywhere), and the wholesale-fallback heuristic there would misread that.
  it('has every session-management string in every language', () => {
    const keys: (keyof Translations)[] = [
      'currentSession', 'device', 'ipAddress', 'lastSeen', 'signOutOthers', 'revokeAllSessions',
      'noActiveSessions', 'rememberMe',
    ]
    for (const { code } of SUPPORTED_LANGUAGES) {
      for (const key of keys) {
        expect(t(key, code), `${code}.${key}`).toBeTruthy()
        expect(String(t(key, code)), `${code}.${key}`).not.toBe('undefined')
      }
    }
  })
})
