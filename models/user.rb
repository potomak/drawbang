class User
  def initialize(user)
    @user = user
  end
  
  # Save user record and return user hash.
  def save
    REDIS.set @user.delete(:key), @user.to_json
    @user # NOTE: SET can't fail (http://redis.io/commands/set)
  end
  
  # Find user by +id+.
  def self.find(id)
    find_by_key(key(id))
  end
  
  # Finds user by +key+.
  def self.find_by_key(key)
    user = REDIS.get(key)
    JSON.parse(user) unless user.nil?
  end
  
  # Update user at +key+.
  def self.update(key, hash)
    user = User.find_by_key(key)
    return nil unless user
    User.new(user.merge(:key => key).merge(hash)).save
  end
  
  # Returns user's key for +id+.
  def self.key(id)
    "user:#{id}"
  end
end