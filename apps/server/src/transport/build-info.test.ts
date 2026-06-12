import { describe, expect, it } from 'vitest'
import { createDeploymentInfo } from './build-info.ts'

describe('createDeploymentInfo', () => {
  it('always returns schema-complete deployment statistics', () => {
    const deploymentInfo = createDeploymentInfo()

    expect(deploymentInfo).toMatchObject({
      object: 'regesta.deployment-info',
      statistics: {
        packages: 0,
      },
    })
    expect(Object.keys(deploymentInfo).toSorted()).toEqual([
      'build',
      'git',
      'object',
      'runtime',
      'service',
      'statistics',
      'version',
    ])
    expect(deploymentInfo).not.toHaveProperty('api')
  })

  it('preserves valid deployment statistics', () => {
    expect(
      createDeploymentInfo({ statistics: { packages: 42 } }),
    ).toMatchObject({
      statistics: {
        packages: 42,
      },
    })
  })

  it('normalizes deployment statistics to documented fields', () => {
    const input = Object.assign({ packages: 42 }, { transient: true })

    expect(createDeploymentInfo({ statistics: input }).statistics).toEqual({
      packages: 42,
    })
  })

  it('rejects schema-invalid deployment statistics', () => {
    for (const packages of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        createDeploymentInfo({
          statistics: {
            packages,
          },
        }),
      ).toThrow(
        'Deployment package statistics must be a non-negative safe integer',
      )
    }
  })
})
