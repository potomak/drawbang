class User
  def initialize(user)
    @user = user
  end
  
  def save
    REDIS.set @user.delete(:key), @user.to_json
  end
  
  def self.find(key)
    JSON.parse(REDIS.get(key))
  end
end