import { addProject, projectsRoot } from './src/main/projects.ts'
const repo = 'Ithelastghostl/bloomsbury-crm'
console.log('cloning', repo, 'into', projectsRoot())
const p = await addProject(repo)
console.log('PROJECT:', JSON.stringify(p, null, 2))
