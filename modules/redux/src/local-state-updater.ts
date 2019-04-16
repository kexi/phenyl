import { update, createDocumentPath } from 'sp2'
import { GeneralUpdateOperation } from '@sp2/format'
import { createError } from '@phenyl/utils'
import { removeOne } from './utils'
import {
  IdUpdateCommand,
  LocalState,
  PhenylError,
  PushCommand,
  Session,
  VersionDiff,
  UnreachedCommit,
  GeneralReqResEntityMap,
  GeneralAuthCommandMap,
  Key,
  Entity,
} from '@phenyl/interfaces'
import { LocalStateFinder } from './local-state-finder'
type LocalStateOf = LocalState<GeneralReqResEntityMap, GeneralAuthCommandMap>

type EntityName = string
type Id = string
type ActionTag = string
type RevertCommand<N extends EntityName> = {
  entityName: N
  id: Id
  operations: Array<GeneralUpdateOperation>
}
/**
 *
 */

export class LocalStateUpdater {
  /**
   * Initialize the given entity field.
   */
  static initialize<M extends GeneralReqResEntityMap, EN extends Key<M>>(
    state: LocalStateOf,
    entityName: EN,
  ): GeneralUpdateOperation {
    return {
      $set: {
        [createDocumentPath('entities', entityName)]: {},
      },
    }
  }
  /**
   * Commit the operation of entity to LocalState.
   * Error is thrown when no entity is registered.
   */

  static commit<GM extends GeneralReqResEntityMap, EN extends Key<GM>>(
    state: LocalStateOf,
    command: IdUpdateCommand<EN>,
  ): GeneralUpdateOperation {
    const { entityName, id, operation } = command

    if (
      !LocalStateFinder.hasEntity(state, {
        entityName,
        id,
      })
    ) {
      throw new Error(
        `LocalStateUpdater.commit(). No entity found. entityName: "${entityName}", id: "${id}".`,
      )
    }

    const entity = LocalStateFinder.getHeadEntity(state, {
      id,
      entityName,
    })
    const newEntity = update(entity, operation)
    return {
      $push: {
        [createDocumentPath('entities', entityName, id, 'commits')]: operation,
      },
      $set: {
        [createDocumentPath('entities', entityName, id, 'head')]: newEntity,
      },
    }
  }
  /**
   * Revert the already applied commit.
   * Error is thrown when no entity is registered.
   */

  static revert<GM extends GeneralReqResEntityMap, EN extends Key<GM>>(
    state: LocalStateOf,
    command: RevertCommand<EN>,
  ): GeneralUpdateOperation {
    const { entityName, id, operations } = command

    if (
      !LocalStateFinder.hasEntity(state, {
        entityName,
        id,
      })
    ) {
      throw new Error(
        `LocalStateUpdater.revert(). No entity found. entityName: "${entityName}", id: "${id}".`,
      )
    }

    const entityInfo = LocalStateFinder.getEntityInfo(state, {
      id,
      entityName,
    })
    const commits = operations.reduce(
      (restCommits, op) => removeOne(restCommits, op),
      entityInfo.commits,
    )
    const restoredHead = update(entityInfo.origin, ...commits)
    return {
      $set: {
        [createDocumentPath('entities', entityName, id, 'commits')]: commits,
        [createDocumentPath('entities', entityName, id, 'head')]: restoredHead,
      },
    }
  }
  /**
   * Register the entity info into LocalState.
   * Overwrite if already exists.
   */

  static follow<GM extends GeneralReqResEntityMap, EN extends Key<GM>>(
    state: LocalStateOf,
    entityName: EN,
    entity: Entity,
    versionId: Id | undefined | null,
  ): GeneralUpdateOperation {
    return {
      $set: {
        [createDocumentPath('entities', entityName, entity.id)]: {
          origin: entity,
          versionId,
          commits: [],
          head: null,
        },
      },
    }
  }
  /**
   * Remove the entity info from LocalState.
   */

  static unfollow<GM extends GeneralReqResEntityMap, EN extends Key<GM>>(
    state: LocalStateOf,
    entityName: EN,
    id: Id,
  ): GeneralUpdateOperation {
    return {
      $unset: {
        [createDocumentPath('entities', entityName, id)]: '',
      },
    }
  }
  /**
   * Push network request promise.
   */

  static addUnreachedCommits<
    GM extends GeneralReqResEntityMap,
    EN extends Key<GM>
  >(state: LocalStateOf, commit: UnreachedCommit<EN>): GeneralUpdateOperation {
    const { entityName, id, commitCount } = commit
    const enqueuedCount = state.unreachedCommits
      .filter(c => c.entityName === entityName && c.id === id)
      .reduce((acc, c) => acc + c.commitCount, 0)

    if (commitCount <= enqueuedCount) {
      return {}
    }

    return {
      $push: {
        [createDocumentPath('unreachedCommits')]: {
          entityName,
          id,
          commitCount: commitCount - enqueuedCount,
        },
      },
    }
  }
  /**
   * Remove network request promise from the request queue.
   */

  static removeUnreachedCommits<
    GM extends GeneralReqResEntityMap,
    EN extends Key<GM>
  >(state: LocalStateOf, commit: UnreachedCommit<EN>): GeneralUpdateOperation {
    return {
      $pull: {
        [createDocumentPath('unreachedCommits')]: {
          $in: [commit],
        },
      },
    }
  }
  /**
   * Push network request promise.
   */

  static networkRequest(
    state: LocalStateOf,
    tag: ActionTag,
  ): GeneralUpdateOperation {
    return {
      $push: {
        [createDocumentPath('network', 'requests')]: tag,
      },
    }
  }
  /**
   * Remove network request promise from the request queue.
   */

  static removeNetworkRequest(
    state: LocalStateOf,
    tag: ActionTag,
  ): GeneralUpdateOperation {
    return {
      $set: {
        [createDocumentPath('network', 'requests')]: removeOne(
          state.network.requests,
          tag,
        ),
      },
    }
  }
  /**
   * Apply the given VersionDiff as a patch.
   * If the diff's prevVersionId isn't equal to registered versionId, no operation is returned.
   * If it equals, applied to origin.
   */

  static patch(
    state: LocalStateOf,
    versionDiff: VersionDiff,
  ): GeneralUpdateOperation {
    const { entityName, id, versionId, prevVersionId, operation } = versionDiff
    const entityInfo = LocalStateFinder.getEntityInfo(state, {
      id,
      entityName,
    }) // Not applicable diff.

    if (entityInfo.versionId !== prevVersionId) {
      return {}
    }

    const newOrigin = update(entityInfo.origin, operation)
    const newHead = update(newOrigin, ...entityInfo.commits)
    return {
      $set: {
        [createDocumentPath('entities', entityName, id, 'origin')]: newOrigin,
        [createDocumentPath(
          'entities',
          entityName,
          id,
          'versionId',
        )]: versionId,
        [createDocumentPath('entities', entityName, id, 'head')]: newHead,
      },
    }
  }
  /**
   * Apply the master commits.
   * If local commits exist, apply them after master commits.
   */

  static rebase<GM extends GeneralReqResEntityMap, EN extends Key<GM>>(
    state: LocalStateOf,
    pushCommand: PushCommand<EN>,
  ): GeneralUpdateOperation {
    const { entityName, id, versionId, operations } = pushCommand
    const entityInfo = LocalStateFinder.getEntityInfo(state, {
      id,
      entityName,
    })
    const newOrigin = update(entityInfo.origin, ...operations)
    const newHead =
      entityInfo.commits.length > 0
        ? update(newOrigin, ...entityInfo.commits)
        : null
    return {
      $set: {
        [createDocumentPath('entities', entityName, id, 'origin')]: newOrigin,
        [createDocumentPath(
          'entities',
          entityName,
          id,
          'versionId',
        )]: versionId,
        [createDocumentPath('entities', entityName, id, 'head')]: newHead,
      },
    }
  }
  /**
   * Apply the master commits, then apply the given local commits.
   */

  static synchronize<GM extends GeneralReqResEntityMap, EN extends Key<GM>>(
    state: LocalStateOf,
    pushCommand: PushCommand<EN>,
    localCommits: Array<GeneralUpdateOperation>,
  ): GeneralUpdateOperation {
    const { entityName, id, operations, versionId } = pushCommand
    const entityInfo = LocalStateFinder.getEntityInfo(state, {
      id,
      entityName,
    })
    const newOrigin = update(entityInfo.origin, ...operations, ...localCommits) // assert(localCommits.length === 0 || entityInfo.commits[0] === localCommits[0])

    const newCommits = entityInfo.commits.slice(localCommits.length)
    const newHead =
      newCommits.length > 0 ? update(newOrigin, ...newCommits) : null
    return {
      $set: {
        [createDocumentPath('entities', entityName, id)]: {
          origin: newOrigin,
          versionId,
          commits: newCommits,
          head: newHead,
        },
      },
    }
  }
  /**
   * Register all the entities into LocalState.
   * NOTICE: if returned type of this.follow() changes, this implementation must be changed.
   */

  static followAll<GM extends GeneralReqResEntityMap, EN extends Key<GM>>(
    state: LocalStateOf,
    entityName: EN,
    entities: Entity[],
    versionsById: {
      [entityId: string]: string
    },
  ): GeneralUpdateOperation {
    const $setOp = {}

    for (const entity of entities) {
      const versionId = versionsById[entity.id]
      const operation = this.follow(state, entityName, entity, versionId)
      Object.assign($setOp, operation.$set)
    }

    return {
      $set: $setOp,
    }
  }
  /**
   * Set session.
   */

  static setSession(
    state: LocalStateOf,
    session: Session,
    user: Entity | undefined | null,
    versionId?: string | undefined | null,
  ): GeneralUpdateOperation {
    const { entityName } = session
    const operation = {
      $set: {
        session,
      },
    }

    if (user != null && versionId != null) {
      const followOp = this.follow(state, entityName, user, versionId)
      Object.assign(operation.$set, followOp.$set)
    }

    return operation
  }
  /**
   * Remove session.
   */

  static unsetSession(): GeneralUpdateOperation {
    return {
      $unset: {
        session: '',
      },
    }
  }
  /**
   * Set Error.
   */

  static error(
    e: Error | PhenylError<Object>,
    actionTag: ActionTag,
  ): GeneralUpdateOperation {
    const err = createError(e)
    return {
      $set: {
        error: {
          type: err.type,
          at: err.at,
          message: err.message,
          actionTag,
        },
      },
    }
  }
  /**
   * Set network state Online.
   */

  static online(): GeneralUpdateOperation {
    return {
      $set: {
        [createDocumentPath('network', 'isOnline')]: true,
      },
    }
  }
  /**
   * Set network state Offline.
   */

  static offline(): GeneralUpdateOperation {
    return {
      $set: {
        [createDocumentPath('network', 'isOnline')]: false,
      },
    }
  }
  /**
   * Unset error.
   */

  static resolveError(): GeneralUpdateOperation {
    return {
      $unset: {
        [createDocumentPath('error')]: '',
      },
    }
  }
}
