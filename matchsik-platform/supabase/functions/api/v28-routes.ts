import { createClient, type User } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''

function collectEnvironmentStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string' && value.trim()) out.push(value.trim())
  else if (Array.isArray(value)) value.forEach((item) => collectEnvironmentStrings(item, out))
  else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach((item) => collectEnvironmentStrings(item, out))
  return out
}
function environmentJsonStrings(name: string): string[] {
  try { return collectEnvironmentStrings(JSON.parse(Deno.env.get(name) || '{}')) } catch { return [] }
}
const PUBLISHABLE_KEYS = [
  Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || '',
  Deno.env.get('SUPABASE_ANON_KEY') || '',
  ...environmentJsonStrings('SUPABASE_PUBLISHABLE_KEYS'),
].filter(Boolean)
const SERVICE_KEYS = [
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
  Deno.env.get('SUPABASE_SECRET_KEY') || '',
  ...environmentJsonStrings('SUPABASE_SECRET_KEYS'),
].filter(Boolean)
const PUBLISHABLE_KEY = PUBLISHABLE_KEYS[0] || ''
const SERVICE_KEY = SERVICE_KEYS[0] || ''

const adminDb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
})

class RouteError extends Error {
  status: number
  code: string
  constructor(status: number, message: string, code = `HTTP_${status}`) {
    super(message)
    this.status = status
    this.code = code
  }
}

type JsonObject = Record<string, unknown>
type TeacherAuth = { user: User; teacherId: string; email: string }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  },
})

const text = (value: unknown, max = 5000) => String(value ?? '').trim().slice(0, max)
const arrayStrings = (value: unknown, max = 80): string[] => {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => text(item, max)).filter(Boolean))]
}
const normalizeEmail = (value: unknown) => text(value, 240).toLowerCase()
const validTeacherId = (value: string) => /^[A-Za-z0-9_-]{2,80}$/.test(value)
const hhmm = (value: unknown) => text(value, 5)
const timeMinutes = (value: unknown) => {
  const [hour, minute] = hhmm(value).split(':').map(Number)
  return (Number.isFinite(hour) ? hour : 0) * 60 + (Number.isFinite(minute) ? minute : 0)
}
const kstDateParts = (value: unknown) => {
  const date = new Date(String(value || ''))
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(date)
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return { date: `${map.year}-${map.month}-${map.day}`, time: `${map.hour}:${map.minute}`, day: weekdays[map.weekday] ?? -1 }
}
async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, '0')).join('')
}

async function loginFingerprint(req: Request, email: string) {
  const address = (req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || req.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown').trim()
  const agent = (req.headers.get('user-agent') || '').slice(0, 180)
  return sha256Hex(`${SUPABASE_URL}|TEACHER_LOGIN_V28|${address}|${agent}|${email}`)
}

async function checkTeacherLoginRateLimit(fingerprint: string) {
  const since = new Date(Date.now() - 15 * 60_000).toISOString()
  const { count, error } = await adminDb.from('security_events')
    .select('id', { count: 'exact', head: true })
    .eq('event_type', 'TEACHER_LOGIN_V28')
    .eq('fingerprint_hash', fingerprint)
    .eq('success', false)
    .gte('created_at', since)
  if (!error && (count || 0) >= 8) throw new RouteError(429, '로그인 시도가 여러 번 실패했습니다. 15분 후 다시 시도해 주세요.', 'TEACHER_LOGIN_RATE_LIMIT')
}

async function recordTeacherLogin(fingerprint: string, success: boolean, details: JsonObject = {}) {
  const { error } = await adminDb.from('security_events').insert({
    event_type: 'TEACHER_LOGIN_V28', fingerprint_hash: fingerprint, success, details,
  })
  if (error) console.error('teacher login security log failed', error.code)
}

const maskName = (value: unknown) => {
  const name = text(value, 50)
  if (!name) return ''
  if (name.length === 1) return `${name}*`
  return `${name.slice(0, 1)}${'*'.repeat(Math.min(2, name.length - 1))}`
}

function safeMessage(error: unknown, fallback = '요청 처리 중 오류가 발생했습니다.') {
  const raw = error && typeof error === 'object' && 'message' in error
    ? String((error as { message: unknown }).message || '')
    : ''
  if (!raw || raw.length > 260) return fallback
  if (/(relation|column|constraint|schema|postgres|sqlstate|duplicate key|detail:|context:)/i.test(raw)) return fallback
  return raw
}

async function parseBody(req: Request): Promise<JsonObject> {
  return await req.json().catch(() => ({})) as JsonObject
}

async function authUserFromBearer(req: Request): Promise<User> {
  const auth = req.headers.get('authorization') || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) throw new RouteError(401, '로그인이 필요합니다.', 'AUTH_REQUIRED')
  const apikey = (req.headers.get('apikey') || PUBLISHABLE_KEY).trim()
  if (!apikey) throw new RouteError(500, '서버 공개키 설정이 필요합니다.', 'PUBLISHABLE_KEY_MISSING')

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    method: 'GET',
    headers: { apikey, authorization: `Bearer ${token}` },
  }).catch(() => null)
  if (!response) throw new RouteError(503, '인증 서버에 연결하지 못했습니다.', 'AUTH_NETWORK')
  const payload = await response.json().catch(() => ({})) as JsonObject
  if (!response.ok || !payload.id) throw new RouteError(401, '로그인 세션이 만료되었거나 유효하지 않습니다.', 'AUTH_SESSION_INVALID')
  return payload as unknown as User
}

async function requireAdmin(req: Request): Promise<User> {
  const user = await authUserFromBearer(req)
  const { data, error } = await adminDb.from('admin_users')
    .select('user_id,email,active')
    .eq('user_id', user.id)
    .eq('active', true)
    .maybeSingle()
  if (error) throw new RouteError(500, '관리자 권한을 확인하지 못했습니다.', 'ADMIN_ROLE_QUERY')
  if (!data) throw new RouteError(403, '관리자 권한이 없습니다.', 'ADMIN_ROLE_REQUIRED')
  return user
}

async function ensureTeacherProfile(teacherId: string, email: string) {
  const existing = await adminDb.from('teachers').select('id').eq('id', teacherId).maybeSingle()
  if (existing.error) throw new RouteError(500, '강사 프로필을 확인하지 못했습니다.', 'TEACHER_PROFILE_QUERY')
  if (existing.data) return

  const displayNames: Record<string, string> = {
    HJ: '전기취득맨',
    HM: '전기마스터',
    MG: '패스코드',
  }
  const { error } = await adminDb.from('teachers').insert({
    id: teacherId,
    name: displayNames[teacherId] || email.split('@')[0] || '강사',
    role: '자격증 전문 강사',
    groups: ['전기'],
    specialties: [],
    courses: ['필기'],
    tags: [],
    teaching_style: '수강생의 현재 수준을 확인한 뒤 이해 중심으로 수업합니다.',
    career_summary: '',
    verified_title: '',
    completed_lessons: 0,
    active: true,
    sort_order: 100,
    certifications: [],
    teaching_assignments: [],
  })
  if (error) throw new RouteError(403, '연결된 강사 프로필을 복구하지 못했습니다.', 'TEACHER_PROFILE_REPAIR_FAILED')
}

async function requireTeacher(req: Request): Promise<TeacherAuth> {
  const user = await authUserFromBearer(req)
  const email = normalizeEmail(user.email)
  const { data: link, error } = await adminDb.from('teacher_users')
    .select('user_id,teacher_id,email,active')
    .or(`user_id.eq.${user.id},email.ilike.${email}`)
    .eq('active', true)
    .maybeSingle()
  if (error) throw new RouteError(500, '강사 계정 연결을 확인하지 못했습니다.', 'TEACHER_LINK_QUERY')
  if (!link) {
    throw new RouteError(403, '연결된 강사 계정이 없거나 비활성화되었습니다.', 'TEACHER_LINK_MISSING')
  }

  const teacherId = text(link.teacher_id, 80)
  await ensureTeacherProfile(teacherId, email)
  return { user, teacherId, email }
}

async function catalogRows() {
  const { data, error } = await adminDb.from('certificate_catalog')
    .select('code,name,category,group_name,allowed_courses,exam_schedule,source_url,source_label,active,sort_order')
    .eq('active', true)
    .order('sort_order')
    .order('name')
  if (error) throw new RouteError(500, '자격증 목록을 불러오지 못했습니다.', 'CATALOG_QUERY')
  return data || []
}

async function assignmentRows(teacherIds?: string[]) {
  let query = adminDb.from('teacher_course_assignments')
    .select('teacher_id,certificate_code,course_type,active,certificate_catalog(code,name,category,group_name,allowed_courses,sort_order)')
    .eq('active', true)
    .order('teacher_id')
    .order('certificate_code')
    .order('course_type')
  if (teacherIds?.length) query = query.in('teacher_id', teacherIds)
  const { data, error } = await query
  if (error) throw new RouteError(500, '강사 수업 참여 정보를 불러오지 못했습니다.', 'ASSIGNMENT_QUERY')
  return data || []
}

function groupAssignments(rows: JsonObject[]) {
  const grouped = new Map<string, { certificateCode: string; cert: string; category: string; group: string; courses: string[] }>()
  for (const row of rows) {
    const relation = row.certificate_catalog as JsonObject | JsonObject[] | null
    const catalog = Array.isArray(relation) ? (relation[0] || null) : relation
    const code = text(row.certificate_code, 100)
    if (!code) continue
    const existing = grouped.get(code) || {
      certificateCode: code,
      cert: text(catalog?.name, 120),
      category: text(catalog?.category, 50),
      group: text(catalog?.group_name, 50),
      courses: [],
    }
    const course = text(row.course_type, 20)
    if (course && !existing.courses.includes(course)) existing.courses.push(course)
    grouped.set(code, existing)
  }
  return [...grouped.values()].sort((a, b) => a.cert.localeCompare(b.cert, 'ko'))
}

async function validateAssignments(raw: unknown) {
  if (!Array.isArray(raw)) throw new RouteError(400, '수업 참여 자격증 형식이 올바르지 않습니다.', 'ASSIGNMENTS_INVALID')
  const catalog = await catalogRows()
  const catalogMap = new Map(catalog.map((row) => [row.code, row]))
  const normalized: Array<{ certificateCode: string; courses: string[] }> = []

  for (const item of raw) {
    const obj = (item || {}) as JsonObject
    const certificateCode = text(obj.certificateCode || obj.code, 100)
    const row = catalogMap.get(certificateCode)
    if (!row) throw new RouteError(400, '목록에 없는 자격증이 포함되어 있습니다.', 'CERTIFICATE_UNKNOWN')
    const allowed = arrayStrings(row.allowed_courses, 20)
    const courses = arrayStrings(obj.courses, 20)
    if (!courses.length) continue
    for (const course of courses) {
      if (!allowed.includes(course)) {
        throw new RouteError(400, `${row.name}에서는 ${course} 과정을 운영할 수 없습니다.`, 'COURSE_NOT_ALLOWED')
      }
      if (certificateCode === 'electric-craftsman' && course !== '필기') {
        throw new RouteError(400, '전기기능사는 필기 과정만 운영합니다.', 'ELECTRIC_CRAFTSMAN_WRITTEN_ONLY')
      }
    }
    normalized.push({ certificateCode, courses })
  }
  return normalized
}

async function saveTeacherProfile(
  oldId: string,
  body: JsonObject,
  actor: User,
  actorRole: 'ADMIN' | 'TEACHER',
) {
  const profile = (body.profile || body) as JsonObject
  const requestedId = actorRole === 'TEACHER' ? oldId : text(profile.id || oldId, 80)
  if (!validTeacherId(requestedId)) throw new RouteError(400, '강사 ID 형식을 확인해 주세요.', 'TEACHER_ID_INVALID')
  const name = text(profile.name, 50)
  if (!name) throw new RouteError(400, '강사 이름을 입력해 주세요.', 'TEACHER_NAME_REQUIRED')
  const assignments = await validateAssignments(body.assignments || profile.teachingAssignments || [])

  const payload = {
    id: requestedId,
    name,
    role: text(profile.role, 100),
    specialties: arrayStrings(profile.specialties || profile.tags, 100),
    tags: arrayStrings(profile.tags, 100),
    teachingStyle: text(profile.teachingStyle || profile.teaching_style, 2000),
    profileImageUrl: text(profile.profileImageUrl || profile.profile_image_url, 1000),
    careerSummary: text(profile.careerSummary || profile.career_summary, 2000),
    verifiedTitle: text(profile.verifiedTitle || profile.verified_title, 200),
    completedLessons: Math.max(0, Math.floor(Number(profile.completedLessons || profile.completed_lessons || 0))),
    active: profile.active !== false,
    sortOrder: Math.floor(Number(profile.sortOrder || profile.sort_order || 100)),
  }

  const { data, error } = await adminDb.rpc('matchsik_save_teacher_profile_secure', {
    p_old_id: oldId,
    p_profile: payload,
    p_assignments: assignments,
    p_actor_user_id: actor.id,
    p_actor_email: normalizeEmail(actor.email),
    p_actor_role: actorRole,
  })
  if (error) throw new RouteError(409, safeMessage(error, '강사 정보를 저장하지 못했습니다.'), 'TEACHER_SAVE_FAILED')
  return data
}

async function teacherLogin(req: Request) {
  const body = await parseBody(req)
  const email = normalizeEmail(body.email)
  const password = text(body.password, 300)
  if (!email || password.length < 8) throw new RouteError(400, '강사 이메일과 비밀번호를 확인해 주세요.', 'TEACHER_CREDENTIALS_REQUIRED')
  const fingerprint = await loginFingerprint(req, email)
  await checkTeacherLoginRateLimit(fingerprint)
  const requestPublishableKey = (req.headers.get('apikey') || PUBLISHABLE_KEY).trim()
  if (!requestPublishableKey) throw new RouteError(500, 'Supabase 공개키가 설정되지 않았습니다.', 'PUBLISHABLE_KEY_MISSING')

  const authResponse = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: requestPublishableKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }).catch(() => null)
  if (!authResponse) throw new RouteError(503, '인증 서버에 연결하지 못했습니다.', 'AUTH_NETWORK')
  const authPayload = await authResponse.json().catch(() => ({})) as JsonObject
  if (!authResponse.ok || !authPayload.access_token) {
    await recordTeacherLogin(fingerprint, false, { stage: 'password' })
    throw new RouteError(401, '이메일 또는 비밀번호가 올바르지 않습니다.', 'TEACHER_LOGIN_FAILED')
  }

  const user = authPayload.user as JsonObject
  const userId = text(user?.id, 100)
  const { data: link, error } = await adminDb.from('teacher_users')
    .select('user_id,teacher_id,email,active')
    .or(`user_id.eq.${userId},email.ilike.${email}`)
    .eq('active', true)
    .maybeSingle()
  if (error) throw new RouteError(500, '강사 계정 연결을 확인하지 못했습니다.', 'TEACHER_LINK_QUERY')
  if (!link) throw new RouteError(403, '연결된 강사 계정이 없거나 비활성화되었습니다.', 'TEACHER_LINK_MISSING')

  const teacherId = text(link.teacher_id, 80)
  await ensureTeacherProfile(teacherId, email)
  const linkUpdate: JsonObject = { last_login_at: new Date().toISOString() }
  if (text(link.user_id, 100) !== userId) linkUpdate.user_id = userId
  const updateResult = await adminDb.from('teacher_users').update(linkUpdate).eq('email', link.email)
  if (updateResult.error) console.error('teacher user link refresh failed', updateResult.error.code)
  await recordTeacherLogin(fingerprint, true, { teacherId })

  return {
    token: authPayload.access_token,
    expiresAt: authPayload.expires_at,
    teacher: { id: teacherId, email },
  }
}

async function teacherDashboard(auth: TeacherAuth) {
  const from = new Date()
  from.setDate(1)
  from.setMonth(from.getMonth() - 1)
  const to = new Date()
  to.setMonth(to.getMonth() + 13)

  const [profileResult, assignmentsResult, catalogResult, availabilityResult, closuresResult, lessonsResult, reservationsResult, proofResult, reviewsResult] = await Promise.all([
    adminDb.from('teachers').select('*').eq('id', auth.teacherId).single(),
    assignmentRows([auth.teacherId]),
    catalogRows(),
    adminDb.from('teacher_availability').select('id,day_of_week,start_time,end_time,active').eq('teacher_id', auth.teacherId).order('day_of_week').order('start_time'),
    adminDb.from('teacher_closures').select('id,closure_date,closure_time,reason').eq('teacher_id', auth.teacherId).gte('closure_date', from.toISOString().slice(0, 10)).lte('closure_date', to.toISOString().slice(0, 10)).order('closure_date'),
    adminDb.from('lessons').select('id,application_code,starts_at,ends_at,status').eq('teacher_id', auth.teacherId).gte('starts_at', from.toISOString()).lte('starts_at', to.toISOString()).order('starts_at'),
    adminDb.from('application_reservations').select('id,application_code,lesson_date,lesson_time,starts_at,ends_at,hold_status,applications(student_name,cert,course,status)').eq('teacher_id', auth.teacherId).gte('starts_at', from.toISOString()).lte('starts_at', to.toISOString()).order('starts_at'),
    adminDb.from('teacher_proofs').select('teacher_id,pass_rate,applicants,passed,period,basis,verified').eq('teacher_id', auth.teacherId).maybeSingle(),
    adminDb.from('reviews').select('id,teacher_id,student_display,cert,course,content,tags,verified,published,created_at').eq('teacher_id', auth.teacherId).order('created_at', { ascending: false }).limit(100),
  ])

  if (profileResult.error) throw new RouteError(500, '강사 프로필을 불러오지 못했습니다.', 'TEACHER_PROFILE_QUERY')
  const reservations = (reservationsResult.data || []).map((row: JsonObject) => {
    const applicationRelation = row.applications as JsonObject | JsonObject[] | null
    const application = Array.isArray(applicationRelation) ? (applicationRelation[0] || null) : applicationRelation
    return {
      id: row.id,
      applicationCode: row.application_code,
      date: row.lesson_date,
      time: row.lesson_time,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      status: row.hold_status,
      studentName: maskName(application?.student_name),
      cert: text(application?.cert, 100),
      course: text(application?.course, 30),
      applicationStatus: text(application?.status, 50),
    }
  })

  return {
    teacher: profileResult.data,
    assignments: groupAssignments(assignmentsResult as unknown as JsonObject[]),
    catalog: catalogResult,
    availability: availabilityResult.data || [],
    closures: closuresResult.data || [],
    lessons: lessonsResult.data || [],
    reservations,
    proof: proofResult.data || null,
    reviews: reviewsResult.data || [],
    warnings: [availabilityResult.error, closuresResult.error, lessonsResult.error, reservationsResult.error, proofResult.error, reviewsResult.error]
      .filter(Boolean)
      .map(() => '일부 보조 정보를 불러오지 못했습니다.'),
  }
}

async function publicTeachers() {
  const { data, error } = await adminDb.from('teachers')
    .select('id,name,role,tags,teaching_style,profile_image_url,career_summary,verified_title,completed_lessons,active,sort_order')
    .eq('active', true)
    .order('sort_order')
    .order('name')
  if (error) throw new RouteError(500, '강사 목록을 불러오지 못했습니다.', 'PUBLIC_TEACHERS_QUERY')
  const teachers = data || []
  const teacherIds = teachers.map((row) => row.id)
  const [assignments, availabilityResult] = await Promise.all([
    assignmentRows(teacherIds),
    teacherIds.length
      ? adminDb.from('teacher_availability')
          .select('id,teacher_id,day_of_week,start_time,end_time,active')
          .in('teacher_id', teacherIds)
          .eq('active', true)
          .order('day_of_week')
          .order('start_time')
      : Promise.resolve({ data: [], error: null }),
  ])
  if (availabilityResult.error) throw new RouteError(500, '강사 가능시간을 불러오지 못했습니다.', 'PUBLIC_AVAILABILITY_QUERY')
  return teachers.map((teacher) => ({
    ...teacher,
    assignments: groupAssignments((assignments as unknown as JsonObject[]).filter((row) => row.teacher_id === teacher.id)),
    availability: (availabilityResult.data || [])
      .filter((row) => row.teacher_id === teacher.id)
      .map((row) => ({ id: row.id, dayOfWeek: row.day_of_week, start: hhmm(row.start_time), end: hhmm(row.end_time) })),
  }))
}

async function adminTeachers() {
  const { data, error } = await adminDb.from('teachers').select('*').order('sort_order').order('name')
  if (error) throw new RouteError(500, '강사 목록을 불러오지 못했습니다.', 'ADMIN_TEACHERS_QUERY')
  const teachers = data || []
  const assignments = await assignmentRows(teachers.map((row) => row.id))
  const { data: users } = await adminDb.from('teacher_users').select('teacher_id,email,active,last_login_at')
  return teachers.map((teacher) => ({
    ...teacher,
    assignments: groupAssignments((assignments as unknown as JsonObject[]).filter((row) => row.teacher_id === teacher.id)),
    login: (users || []).find((item) => item.teacher_id === teacher.id) || null,
  }))
}

async function saveAvailability(auth: TeacherAuth, body: JsonObject) {
  const day = Number(body.dayOfWeek ?? body.day_of_week)
  const start = text(body.startTime || body.start_time, 5)
  const end = text(body.endTime || body.end_time, 5)
  if (!Number.isInteger(day) || day < 0 || day > 6 || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || start >= end) {
    throw new RouteError(400, '요일과 시작·종료 시간을 확인해 주세요.', 'AVAILABILITY_INVALID')
  }
  const { data, error } = await adminDb.from('teacher_availability').insert({
    teacher_id: auth.teacherId,
    day_of_week: day,
    start_time: start,
    end_time: end,
    active: true,
  }).select('*').single()
  if (error) throw new RouteError(409, safeMessage(error, '가능시간을 저장하지 못했습니다.'), 'AVAILABILITY_SAVE_FAILED')
  return data
}

async function saveClosure(auth: TeacherAuth, body: JsonObject) {
  const date = text(body.date || body.closureDate || body.closure_date, 10)
  const time = text(body.time || body.closureTime || body.closure_time, 5)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || (time && !/^\d{2}:\d{2}$/.test(time))) {
    throw new RouteError(400, '휴무 날짜와 시간을 확인해 주세요.', 'CLOSURE_INVALID')
  }
  const { data, error } = await adminDb.from('teacher_closures').insert({
    teacher_id: auth.teacherId,
    closure_date: date,
    closure_time: time || null,
    reason: text(body.reason, 500),
  }).select('*').single()
  if (error) throw new RouteError(409, safeMessage(error, '휴무를 저장하지 못했습니다.'), 'CLOSURE_SAVE_FAILED')
  return data
}

export async function handleV28(req: Request, path: string, method: string): Promise<Response | null> {
  const handled =
    path === '/api/certificates' ||
    path === '/api/exam-schedules' ||
    path === '/api/teachers' ||
    path.startsWith('/api/teacher/') ||
    path === '/api/admin/teachers' ||
    /^\/api\/admin\/teachers\/[^/]+$/.test(path)
  if (!handled) return null

  try {
    if (method === 'GET' && path === '/api/certificates') return json({ items: await catalogRows() })
    if (method === 'GET' && path === '/api/exam-schedules') {
      const url = new URL(req.url)
      const certificateCode = text(url.searchParams.get('certificateCode') || 'electric-craftsman', 100)
      const { data, error } = await adminDb.from('certificate_catalog')
        .select('code,name,allowed_courses,exam_schedule,source_url,source_label')
        .eq('code', certificateCode)
        .eq('active', true)
        .maybeSingle()
      if (error) throw new RouteError(500, '시험 일정을 불러오지 못했습니다.', 'SCHEDULE_QUERY')
      if (!data) throw new RouteError(404, '시험 일정을 찾을 수 없습니다.', 'SCHEDULE_NOT_FOUND')
      return json({ certificate: data })
    }
    if (method === 'GET' && path === '/api/teachers') return json({ items: await publicTeachers() })

    if (method === 'POST' && path === '/api/teacher/login') return json(await teacherLogin(req))
    if (method === 'GET' && path === '/api/teacher/session-check') {
      const auth = await requireTeacher(req)
      return json({ ok: true, teacher: { id: auth.teacherId, email: auth.email } })
    }
    if (method === 'GET' && path === '/api/teacher/dashboard') {
      const auth = await requireTeacher(req)
      return json(await teacherDashboard(auth))
    }
    if ((method === 'PUT' || method === 'POST') && path === '/api/teacher/profile') {
      const auth = await requireTeacher(req)
      const body = await parseBody(req)
      const teacher = await saveTeacherProfile(auth.teacherId, body, auth.user, 'TEACHER')
      return json({ teacher, dashboard: await teacherDashboard(auth) })
    }
    if (method === 'POST' && path === '/api/teacher/availability') {
      const auth = await requireTeacher(req)
      return json({ item: await saveAvailability(auth, await parseBody(req)) }, 201)
    }
    const availabilityMatch = path.match(/^\/api\/teacher\/availability\/(\d+)$/)
    if (method === 'DELETE' && availabilityMatch) {
      const auth = await requireTeacher(req)
      const ruleResult = await adminDb.from('teacher_availability')
        .select('id,day_of_week,start_time,end_time')
        .eq('id', Number(availabilityMatch[1])).eq('teacher_id', auth.teacherId).maybeSingle()
      if (ruleResult.error) throw new RouteError(500, '가능시간을 확인하지 못했습니다.', 'AVAILABILITY_QUERY_FAILED')
      if (!ruleResult.data) throw new RouteError(404, '가능시간을 찾지 못했습니다.', 'AVAILABILITY_NOT_FOUND')

      const futureResult = await adminDb.from('application_reservations')
        .select('id,starts_at,hold_status')
        .eq('teacher_id', auth.teacherId)
        .in('hold_status', ['HELD', 'APPROVED'])
        .gte('starts_at', new Date().toISOString())
        .limit(1000)
      if (futureResult.error) throw new RouteError(500, '기존 예약 영향을 확인하지 못했습니다.', 'AVAILABILITY_IMPACT_QUERY_FAILED')
      const start = timeMinutes(ruleResult.data.start_time)
      const end = timeMinutes(ruleResult.data.end_time)
      const affected = (futureResult.data || []).some((row: JsonObject) => {
        const parts = kstDateParts(row.starts_at)
        const lessonStart = timeMinutes(parts.time)
        return parts.day === Number(ruleResult.data.day_of_week) && lessonStart >= start && lessonStart < end
      })
      if (affected) throw new RouteError(409, '입금 확인 중이거나 확정된 미래 수업이 있어 이 가능시간을 삭제할 수 없습니다. 먼저 일정 변경을 요청해 주세요.', 'AVAILABILITY_HAS_ACTIVE_BOOKINGS')

      const { error } = await adminDb.from('teacher_availability').delete()
        .eq('id', Number(availabilityMatch[1])).eq('teacher_id', auth.teacherId)
      if (error) throw new RouteError(409, safeMessage(error, '가능시간을 삭제하지 못했습니다.'), 'AVAILABILITY_DELETE_FAILED')
      return json({ ok: true })
    }
    if (method === 'POST' && path === '/api/teacher/closures') {
      const auth = await requireTeacher(req)
      const body = await parseBody(req)
      const closureDate = text(body.date || body.closureDate || body.closure_date, 10)
      const closureTime = text(body.time || body.closureTime || body.closure_time, 5)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(closureDate) || (closureTime && !/^\d{2}:\d{2}$/.test(closureTime))) {
        throw new RouteError(400, '휴무 날짜와 시간을 확인해 주세요.', 'CLOSURE_INVALID')
      }
      const conflictResult = await adminDb.from('application_reservations')
        .select('id,lesson_date,lesson_time,hold_status')
        .eq('teacher_id', auth.teacherId)
        .eq('lesson_date', closureDate)
        .in('hold_status', ['HELD', 'APPROVED'])
        .limit(200)
      if (conflictResult.error) throw new RouteError(500, '기존 예약 영향을 확인하지 못했습니다.', 'CLOSURE_IMPACT_QUERY_FAILED')
      const conflict = (conflictResult.data || []).some((row: JsonObject) => !closureTime || hhmm(row.lesson_time) === closureTime)
      if (conflict) throw new RouteError(409, '입금 확인 중이거나 확정된 수업과 겹쳐 휴무를 등록할 수 없습니다. 먼저 일정 변경을 요청해 주세요.', 'CLOSURE_HAS_ACTIVE_BOOKINGS')
      return json({ item: await saveClosure(auth, body) }, 201)
    }
    if (method === 'POST' && path === '/api/teacher/proof') {
      const auth = await requireTeacher(req)
      const body = await parseBody(req)
      const applicants = Math.max(0, Math.floor(Number(body.applicants || 0)))
      const passed = Math.max(0, Math.floor(Number(body.passed || 0)))
      if (passed > applicants && applicants > 0) throw new RouteError(400, '합격자 수는 응시자 수보다 클 수 없습니다.', 'PROOF_COUNTS_INVALID')
      const passRate = applicants > 0 ? Math.round((passed / applicants) * 1000) / 10 : Math.max(0, Math.min(100, Number(body.passRate || body.pass_rate || 0)))
      const { data, error } = await adminDb.from('teacher_proofs').upsert({
        teacher_id: auth.teacherId,
        pass_rate: passRate,
        applicants,
        passed,
        period: text(body.period, 100),
        basis: text(body.basis, 2000),
        verified: false,
        submitted_by_user_id: auth.user.id,
        submitted_at: new Date().toISOString(),
      }, { onConflict: 'teacher_id' }).select('*').single()
      if (error) throw new RouteError(409, safeMessage(error, '합격률 자료를 제출하지 못했습니다.'), 'PROOF_SAVE_FAILED')
      return json({ proof: data })
    }
    if (method === 'POST' && path === '/api/teacher/reviews') {
      const auth = await requireTeacher(req)
      const body = await parseBody(req)
      const content = text(body.content, 2000)
      if (content.length < 10) throw new RouteError(400, '후기 내용을 10자 이상 입력해 주세요.', 'REVIEW_CONTENT_REQUIRED')
      const { data, error } = await adminDb.from('reviews').insert({
        teacher_id: auth.teacherId,
        teacher_name: text(body.teacherName, 50),
        student_display: text(body.studentDisplay || body.student_display, 30),
        cert: text(body.cert, 100),
        course: text(body.course, 30),
        content,
        tags: arrayStrings(body.tags, 50),
        verified: false,
        published: false,
        submission_source: 'TEACHER',
        submitted_by_user_id: auth.user.id,
      }).select('*').single()
      if (error) throw new RouteError(409, safeMessage(error, '후기를 제출하지 못했습니다.'), 'REVIEW_SAVE_FAILED')
      return json({ review: data }, 201)
    }
    if (method === 'POST' && path === '/api/teacher/change-requests') {
      const auth = await requireTeacher(req)
      const body = await parseBody(req)
      const reservationId = Number(body.reservationId || body.reservation_id)
      const requestedDate = text(body.requestedDate || body.requested_date, 10)
      const requestedTime = text(body.requestedTime || body.requested_time, 5)
      if (!Number.isInteger(reservationId) || !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate) || !/^\d{2}:\d{2}$/.test(requestedTime)) {
        throw new RouteError(400, '변경할 수업과 희망 날짜·시간을 확인해 주세요.', 'CHANGE_REQUEST_INVALID')
      }
      const reservation = await adminDb.from('application_reservations')
        .select('id,application_code,starts_at')
        .eq('id', reservationId).eq('teacher_id', auth.teacherId).maybeSingle()
      if (reservation.error || !reservation.data) throw new RouteError(404, '변경할 수업을 찾지 못했습니다.', 'RESERVATION_NOT_FOUND')
      const { data, error } = await adminDb.from('teacher_schedule_change_requests').insert({
        teacher_id: auth.teacherId,
        application_code: reservation.data.application_code,
        reservation_id: reservationId,
        current_starts_at: reservation.data.starts_at,
        requested_date: requestedDate,
        requested_time: requestedTime,
        reason: text(body.reason, 1000),
        status: 'PENDING',
        requested_by: auth.user.id,
      }).select('*').single()
      if (error) throw new RouteError(409, safeMessage(error, '일정 변경 요청을 저장하지 못했습니다.'), 'CHANGE_REQUEST_SAVE_FAILED')
      return json({ request: data }, 201)
    }
    const closureMatch = path.match(/^\/api\/teacher\/closures\/(\d+)$/)
    if (method === 'DELETE' && closureMatch) {
      const auth = await requireTeacher(req)
      const { error } = await adminDb.from('teacher_closures').delete()
        .eq('id', Number(closureMatch[1])).eq('teacher_id', auth.teacherId)
      if (error) throw new RouteError(409, safeMessage(error, '휴무를 삭제하지 못했습니다.'), 'CLOSURE_DELETE_FAILED')
      return json({ ok: true })
    }

    if (path === '/api/admin/teachers') {
      const admin = await requireAdmin(req)
      if (method === 'GET') return json({ items: await adminTeachers(), catalog: await catalogRows() })
      if (method === 'POST') {
        const body = await parseBody(req)
        const profile = (body.profile || body) as JsonObject
        const oldId = text(body.oldId || profile.id, 80)
        const teacher = await saveTeacherProfile(oldId, body, admin, 'ADMIN')
        return json({ teacher, items: await adminTeachers() }, 201)
      }
    }
    const adminTeacherMatch = path.match(/^\/api\/admin\/teachers\/([^/]+)$/)
    if (adminTeacherMatch) {
      const admin = await requireAdmin(req)
      const oldId = decodeURIComponent(adminTeacherMatch[1])
      if (method === 'PUT' || method === 'PATCH') {
        const teacher = await saveTeacherProfile(oldId, await parseBody(req), admin, 'ADMIN')
        return json({ teacher, items: await adminTeachers() })
      }
      if (method === 'DELETE') {
        const { error } = await adminDb.from('teachers').update({ active: false }).eq('id', oldId)
        if (error) throw new RouteError(409, '강사 비공개 처리에 실패했습니다.', 'TEACHER_DEACTIVATE_FAILED')
        return json({ ok: true })
      }
    }

    return json({ error: '지원하지 않는 요청입니다.', errorCode: 'METHOD_NOT_ALLOWED' }, 405)
  } catch (error) {
    const status = error instanceof RouteError ? error.status : 500
    const errorCode = error instanceof RouteError ? error.code : 'INTERNAL_ERROR'
    console.error('MATCHSIK_V28_ROUTE_ERROR', {
      path,
      method,
      status,
      errorCode,
      message: error instanceof Error ? error.message : String(error),
    })
    return json({
      error: status >= 500 ? '요청 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' : safeMessage(error),
      errorCode,
      requestId: crypto.randomUUID(),
    }, status)
  }
}
